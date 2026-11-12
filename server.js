// MPARADISE HomeScan — backend
// Accounts, saved houses/rooms, and Claude furniture detection (API key stays on the server).
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const HOUSES = path.join(DATA_DIR, 'houses');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
mkdirSync(HOUSES, { recursive: true });

let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  const f = path.join(DATA_DIR, 'secret.key');
  if (!existsSync(f)) writeFileSync(f, crypto.randomBytes(32).toString('hex'));
  SECRET = readFileSync(f, 'utf8').trim();
}

// ---------- tiny JSON store ----------
const readJSON = async (f, fb = null) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return fb; } };
const writeJSON = async (f, d) => {
  await fs.mkdir(path.dirname(f), { recursive: true });
  const tmp = `${f}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(d));
  await fs.rename(tmp, f);
};
const locks = new Map();
function withLock(key, fn) {
  const run = (locks.get(key) || Promise.resolve()).then(fn);
  locks.set(key, run.catch(() => {}));
  return run;
}
const houseFile = (id) => path.join(HOUSES, id, 'house.json');
const roomFile = (hid, rid) => path.join(HOUSES, hid, 'rooms', `${rid}.json`);
const isId = (s) => /^[0-9a-f-]{36}$/i.test(String(s));

// ---------- validation helpers ----------
const TYPES = ['sofa', 'armchair', 'chair', 'table', 'desk', 'bed', 'cabinet', 'shelf', 'wardrobe', 'tv', 'lamp', 'plant', 'rug', 'wall_art', 'appliance', 'door', 'window', 'other'];
const WALL_TYPES = new Set(['tv', 'wall_art', 'window', 'door']);
const DEFAULT_SIZE = { sofa: [2, 0.85, 0.9], armchair: [0.85, 0.85, 0.85], chair: [0.5, 0.9, 0.5], table: [1.4, 0.75, 0.8], desk: [1.2, 0.75, 0.6], bed: [1.6, 0.55, 2], cabinet: [0.9, 0.9, 0.45], shelf: [0.8, 1.8, 0.35], wardrobe: [1.2, 2, 0.6], tv: [1.2, 0.7, 0.06], lamp: [0.4, 1.6, 0.4], plant: [0.5, 1, 0.5], rug: [2, 0.02, 1.4], wall_art: [0.8, 0.6, 0.03], appliance: [0.6, 0.9, 0.6], door: [0.9, 2.05, 0.05], window: [1.2, 1.2, 0.05], other: [0.5, 0.5, 0.5] };
const num = (v, fb = 0) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : fb);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);
const vec3 = (a, fb = [0, 0, 0]) => (Array.isArray(a) && a.length >= 3 ? [num(a[0], fb[0]), num(a[1], fb[1]), num(a[2], fb[2])] : fb.slice());
const cleanType = (t, fb = 'other') => { const s = String(t || '').toLowerCase().replace(/[\s-]+/g, '_'); return TYPES.includes(s) ? s : fb; };
const cleanColor = (c) => (/^#[0-9a-f]{6}$/i.test(String(c)) ? String(c).toLowerCase() : null);
const cleanTransform = (t) => ({ x: num(t?.x), z: num(t?.z), rot: num(t?.rot) });
const cleanBounds = (b) => ({ min: vec3(b?.min, [-2, 0, -2]), max: vec3(b?.max, [2, 2.6, 2]) });
const cleanAlign = (a) => ({
  fov: clamp(num(a?.fov), -30, 30), yaw: clamp(num(a?.yaw), -20, 20), pitch: clamp(num(a?.pitch), -20, 20), roll: clamp(num(a?.roll), -20, 20),
  x: clamp(num(a?.x), -0.3, 0.3), y: clamp(num(a?.y), -0.3, 0.3), z: clamp(num(a?.z), -0.3, 0.3),
});
const MAX_POSED = 40, MAX_PHONE = 8;
const cleanPose = (p) => (p && Array.isArray(p.p) && Array.isArray(p.q) && p.q.length === 4 ? { p: vec3(p.p), q: p.q.map((v) => num(v)) } : null);
function cleanSize(s, type) {
  const d = DEFAULT_SIZE[type] || DEFAULT_SIZE.other;
  const v = vec3(s, d);
  return v.map((x, i) => clamp(x > 0 ? x : d[i], 0.02, 8));
}
function cleanObjects(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 300).map((o, i) => {
    const type = cleanType(o.type);
    return {
      id: clean(o.id, 20) || `o${i}`,
      source: ['quest', 'claude', 'manual'].includes(o.source) ? o.source : 'manual',
      label: clean(o.label, 30),
      type,
      name: clean(o.name, 60) || type,
      color: cleanColor(o.color),
      material: clean(o.material, 30),
      confidence: o.confidence == null ? null : clamp(num(o.confidence), 0, 1),
      center: vec3(o.center),
      size: cleanSize(o.size, type),
      yaw: num(o.yaw),
      flip: !!o.flip,
      approx: !!o.approx,
      ai: !!o.ai,
    };
  });
}
function cleanPlanes(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 500).map((p) => ({
    label: clean(p.label, 30).toLowerCase(),
    points: (Array.isArray(p.points) ? p.points : []).slice(0, 200).map((pt) => vec3(pt)),
    normal: vec3(p.normal, [0, 1, 0]),
  })).filter((p) => p.points.length >= 3);
}
function nextTransform(house, bounds) {
  if (!house.rooms.length) return { x: 0, z: 0, rot: 0 };
  let maxX = -Infinity;
  for (const r of house.rooms) {
    const half = Math.max(r.bounds.max[0] - r.bounds.min[0], r.bounds.max[2] - r.bounds.min[2]) / 2;
    maxX = Math.max(maxX, (r.transform?.x || 0) + half);
  }
  return { x: maxX + 0.6 + (bounds.max[0] - bounds.min[0]) / 2, z: 0, rot: 0 };
}

// ---------- auth ----------
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');
function makeToken(user) {
  const body = Buffer.from(JSON.stringify({ uid: user.id, u: user.username, exp: Date.now() + 1000 * 60 * 60 * 24 * 90 })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`;
}
function readToken(t) {
  try {
    const [body, sig] = String(t).split('.');
    const good = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
    if (!sig || sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
function auth(req, res, next) {
  const p = readToken((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (!p) return res.status(401).json({ error: 'Please sign in again' });
  req.user = p;
  next();
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

app.get('/api/config', (req, res) => res.json({ claudeServerKey: !!process.env.ANTHROPIC_API_KEY, model: MODEL }));

app.post('/api/register', wrap(async (req, res) => {
  const u = String(req.body?.username || '').trim().toLowerCase();
  const pw = String(req.body?.password || '');
  if (!/^[a-z0-9_.-]{3,32}$/.test(u)) return res.status(400).json({ error: 'Username: 3–32 letters, numbers, _ . -' });
  if (pw.length < 6) return res.status(400).json({ error: 'Password needs 6+ characters' });
  const user = await withLock('users', async () => {
    const users = await readJSON(USERS_FILE, {});
    if (users[u]) return null;
    const salt = crypto.randomBytes(16).toString('hex');
    users[u] = { id: crypto.randomUUID(), username: u, salt, hash: hashPw(pw, salt), createdAt: Date.now() };
    await writeJSON(USERS_FILE, users);
    return users[u];
  });
  if (!user) return res.status(409).json({ error: 'That username is taken' });
  res.json({ token: makeToken(user), username: u });
}));

app.post('/api/login', wrap(async (req, res) => {
  const u = String(req.body?.username || '').trim().toLowerCase();
  const users = await readJSON(USERS_FILE, {});
  const user = users[u];
  const ok = user && crypto.timingSafeEqual(Buffer.from(hashPw(req.body?.password || '', user.salt)), Buffer.from(user.hash));
  if (!ok) return res.status(401).json({ error: 'Wrong username or password' });
  res.json({ token: makeToken(user), username: u });
}));

// ---------- houses ----------
async function getHouse(req, res) {
  const h = isId(req.params.id) ? await readJSON(houseFile(req.params.id)) : null;
  if (!h || h.owner !== req.user.uid) { res.status(404).json({ error: 'House not found' }); return null; }
  return h;
}
const summary = (h) => ({
  id: h.id, name: h.name, rooms: h.rooms.length, roomNames: h.rooms.map((r) => r.name),
  items: h.rooms.reduce((n, r) => n + r.objects.length, 0), updatedAt: h.updatedAt,
});

app.get('/api/houses', auth, wrap(async (req, res) => {
  const ids = await fs.readdir(HOUSES).catch(() => []);
  const list = [];
  for (const id of ids) { const h = await readJSON(houseFile(id)); if (h?.owner === req.user.uid) list.push(summary(h)); }
  res.json(list.sort((a, b) => b.updatedAt - a.updatedAt));
}));

app.post('/api/houses', auth, wrap(async (req, res) => {
  const h = { id: crypto.randomUUID(), owner: req.user.uid, name: clean(req.body?.name, 60) || 'My House', createdAt: Date.now(), updatedAt: Date.now(), rooms: [] };
  await writeJSON(houseFile(h.id), h);
  res.json(summary(h));
}));

app.get('/api/houses/:id', auth, wrap(async (req, res) => {
  const h = await getHouse(req, res); if (!h) return;
  for (const r of h.rooms) {
    const heavy = await readJSON(roomFile(h.id, r.id), {});
    r.mesh = heavy.mesh || null;
    r.photoCount = (heavy.photos || []).length;
    r.posedPhotos = (heavy.photos || []).filter((p) => p.pose).length;
  }
  delete h.owner;
  res.json(h);
}));

app.patch('/api/houses/:id', auth, wrap(async (req, res) => {
  const out = await withLock(req.params.id, async () => {
    const h = await getHouse(req, res); if (!h) return null;
    if (req.body?.name) h.name = clean(req.body.name, 60);
    if (Array.isArray(req.body?.rooms)) {
      for (const u of req.body.rooms) { const r = h.rooms.find((x) => x.id === u.id); if (r && u.transform) r.transform = cleanTransform(u.transform); }
    }
    h.updatedAt = Date.now();
    await writeJSON(houseFile(h.id), h);
    return summary(h);
  });
  if (out) res.json(out);
}));

app.delete('/api/houses/:id', auth, wrap(async (req, res) => {
  const h = await getHouse(req, res); if (!h) return;
  await fs.rm(path.join(HOUSES, h.id), { recursive: true, force: true });
  res.json({ ok: true });
}));

// ---------- rooms ----------
app.post('/api/houses/:id/rooms', auth, wrap(async (req, res) => {
  const b = req.body || {};
  const out = await withLock(req.params.id, async () => {
    const h = await getHouse(req, res); if (!h) return null;
    const bounds = cleanBounds(b.bounds);
    const room = {
      id: crypto.randomUUID(), name: clean(b.name, 40) || `Room ${h.rooms.length + 1}`, createdAt: Date.now(),
      bounds, transform: nextTransform(h, bounds), planes: cleanPlanes(b.planes), objects: cleanObjects(b.objects), ai: null,
    };
    const photos = (Array.isArray(b.photos) ? b.photos : []).slice(-MAX_POSED)
      .filter((p) => typeof p?.data === 'string' && p.data.length < 3e6)
      .map((p) => ({ data: p.data, pose: cleanPose(p.pose), hfov: num(p.hfov, 76), aspect: num(p.aspect, 4 / 3) }));
    const mesh = typeof b.mesh?.positions === 'string' && typeof b.mesh?.indices === 'string' ? { positions: b.mesh.positions, indices: b.mesh.indices } : null;
    await writeJSON(roomFile(h.id, room.id), { mesh, photos });
    h.rooms.push(room);
    h.updatedAt = Date.now();
    await writeJSON(houseFile(h.id), h);
    return { ...room, photoCount: photos.length, posedPhotos: photos.filter((p) => p.pose).length };
  });
  if (out) res.json(out);
}));

async function editRoom(req, res, fn) {
  return withLock(req.params.id, async () => {
    const h = await getHouse(req, res); if (!h) return null;
    const room = h.rooms.find((r) => r.id === req.params.rid);
    if (!room) { res.status(404).json({ error: 'Room not found' }); return null; }
    const result = await fn(h, room);
    h.updatedAt = Date.now();
    await writeJSON(houseFile(h.id), h);
    return result;
  });
}

app.patch('/api/houses/:id/rooms/:rid', auth, wrap(async (req, res) => {
  const out = await editRoom(req, res, async (h, room) => {
    const b = req.body || {};
    if (b.name) room.name = clean(b.name, 40);
    if (Array.isArray(b.objects)) room.objects = cleanObjects(b.objects);
    if (b.transform) room.transform = cleanTransform(b.transform);
    if (b.photoAlign) room.photoAlign = cleanAlign(b.photoAlign);
    return room;
  });
  if (out) res.json(out);
}));

app.delete('/api/houses/:id/rooms/:rid', auth, wrap(async (req, res) => {
  const out = await editRoom(req, res, async (h, room) => {
    h.rooms = h.rooms.filter((r) => r.id !== room.id);
    await fs.rm(roomFile(h.id, room.id), { force: true });
    return { ok: true };
  });
  if (out) res.json(out);
}));

// Extra photos (e.g. from a phone) to help Claude identify furniture
app.post('/api/houses/:id/rooms/:rid/photos', auth, wrap(async (req, res) => {
  const images = (Array.isArray(req.body?.images) ? req.body.images : []).filter((d) => typeof d === 'string' && d.length < 3e6).slice(0, 8);
  if (!images.length) return res.status(400).json({ error: 'No images' });
  const out = await editRoom(req, res, async (h, room) => {
    const f = roomFile(h.id, room.id);
    const heavy = await readJSON(f, {});
    const all = heavy.photos || [];
    const phone = [...all.filter((p) => !p.pose), ...images.map((data) => ({ data, pose: null }))].slice(-MAX_PHONE);
    heavy.photos = [...all.filter((p) => p.pose), ...phone];
    await writeJSON(f, heavy);
    return { photoCount: heavy.photos.length };
  });
  if (out) res.json(out);
}));

// Headset photos (with camera position) used to paint the real room onto the scan
app.get('/api/houses/:id/rooms/:rid/photos', auth, wrap(async (req, res) => {
  const h = await getHouse(req, res); if (!h) return;
  const room = h.rooms.find((r) => r.id === req.params.rid);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const heavy = await readJSON(roomFile(h.id, room.id), {});
  res.set('cache-control', 'private, max-age=3600');
  res.json({ photos: (heavy.photos || []).filter((p) => p.pose).map((p) => ({ pose: p.pose, hfov: p.hfov || 76, aspect: p.aspect || 4 / 3, data: p.data })) });
}));

// ---------- Claude furniture detection ----------
const SYSTEM = `You are the vision engine of a 3D home-scanning app. You get a Meta Quest room scan (furniture boxes from the headset's Space Setup, in meters, y is up, floor at y=0) and sometimes photos from the headset camera or a phone. Identify the furniture as accurately as you can. Reply with ONLY one JSON object — no markdown, no commentary.`;

const f2 = (v) => (Math.round(v * 100) / 100).toString();
const fv = (a) => `(${a.map(f2).join(', ')})`;

function buildPrompt(room, photos) {
  const b = room.bounds;
  const lines = [];
  lines.push('ROOM SCAN (meters, y = up, floor at y = 0)');
  lines.push(`Room size: ${f2(b.max[0] - b.min[0])} wide (x) × ${f2(b.max[2] - b.min[2])} deep (z) × ${f2(b.max[1])} high. Bounds x[${f2(b.min[0])}, ${f2(b.max[0])}] z[${f2(b.min[2])}, ${f2(b.max[2])}].`);
  const walls = room.planes.filter((p) => p.label.includes('wall') && !p.label.includes('art')).length;
  const doors = room.planes.filter((p) => p.label.includes('door')).length;
  const windows = room.planes.filter((p) => p.label.includes('window')).length;
  lines.push(`Structure: ${walls} walls, ${doors} doors, ${windows} windows.`);
  const quest = room.objects.filter((o) => o.source !== 'claude');
  lines.push(quest.length ? 'Objects the headset detected:' : 'The headset detected no furniture boxes.');
  for (const o of quest) lines.push(`- id=${o.id} headset_label="${o.label || 'none'}" center=${fv(o.center)} size(w×h×d)=${fv(o.size)}`);
  lines.push(photos.length
    ? `${photos.length} photo(s) are attached above, each introduced by its camera info.`
    : 'No photos — classify from geometry and headset labels only, pick realistic default colors, and keep confidence ≤ 0.6.');
  lines.push(`
TASK
1. For every headset object, give the best furniture type and a short specific name (e.g. "Grey 3-seat sofa", "Oak dining table"). Use the photos for colors/materials. Correct wrong headset labels when the size or photos clearly disagree.
2. In "extra", list furniture clearly visible in the photos that is NOT already in the headset list (max 15, real items only). For headset photos give u, v (0–1 position of the item's center in that photo; u left→right, v top→bottom), distance (meters from the camera) and an estimated size [w,h,d]. For phone photos set u, v and distance to null.
3. Guess the room type and give it a friendly name.

Allowed types: ${TYPES.join(', ')}

Reply with ONLY this JSON shape:
{"roomType":"living room","roomName":"Living Room","summary":"one short sentence","objects":[{"id":"q0","type":"sofa","name":"Grey 3-seat sofa","color":"#7a7f87","material":"fabric","confidence":0.9}],"extra":[{"type":"lamp","name":"Black floor lamp","color":"#222222","photo":0,"u":0.7,"v":0.4,"distance":2.1,"size":[0.4,1.6,0.4]}]}`);
  return lines.join('\n');
}

function rotq(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

function placeFromPhoto(ex, ph, type, size, b) {
  const tx = Math.tan(((ph.hfov || 76) * Math.PI) / 360), ty = tx / (ph.aspect || 4 / 3);
  let d = rotq(ph.pose.q, [(num(ex.u, 0.5) - 0.5) * 2 * tx, -(num(ex.v, 0.5) - 0.5) * 2 * ty, -1]);
  const len = Math.hypot(...d) || 1;
  d = d.map((c) => c / len);
  const dist = clamp(num(ex.distance, 2), 0.3, 12);
  const p = ph.pose.p.map((c, i) => c + d[i] * dist);
  const cx = clamp(p[0], b.min[0] + size[0] / 2, b.max[0] - size[0] / 2);
  const cz = clamp(p[2], b.min[2] + size[2] / 2, b.max[2] - size[2] / 2);
  const cy = WALL_TYPES.has(type) ? clamp(p[1], size[1] / 2, b.max[1] - size[1] / 2) : size[1] / 2;
  return { center: [cx, cy, cz], yaw: Math.atan2(ph.pose.p[0] - cx, ph.pose.p[2] - cz) };
}

function applyDetection(room, ai, photos) {
  const byId = new Map(room.objects.map((o) => [o.id, o]));
  for (const a of Array.isArray(ai.objects) ? ai.objects : []) {
    const o = byId.get(String(a.id));
    if (!o || o.source === 'claude') continue;
    o.type = cleanType(a.type, o.type);
    o.name = clean(a.name, 60) || o.name;
    o.color = cleanColor(a.color) || o.color;
    o.material = clean(a.material, 30);
    o.confidence = a.confidence == null ? null : clamp(num(a.confidence), 0, 1);
    o.ai = true;
  }
  room.objects = room.objects.filter((o) => o.source !== 'claude');
  const unplaced = [];
  (Array.isArray(ai.extra) ? ai.extra : []).slice(0, 15).forEach((ex, i) => {
    const type = cleanType(ex.type);
    const size = cleanSize(ex.size, type);
    const o = { id: `c${i}`, source: 'claude', label: '', type, name: clean(ex.name, 60) || type, color: cleanColor(ex.color), material: '', confidence: null, size, center: null, yaw: 0, flip: false, approx: true, ai: true };
    const ph = photos[num(ex.photo, -1)];
    if (ph?.pose && ex.u != null && ex.v != null) Object.assign(o, placeFromPhoto(ex, ph, type, size, room.bounds));
    else unplaced.push(o);
    room.objects.push(o);
  });
  // Items from phone photos have no position: line them up along the back wall so they can be seen and edited
  let x = room.bounds.min[0] + 0.3;
  for (const o of unplaced) {
    o.center = [Math.min(x + o.size[0] / 2, room.bounds.max[0] - o.size[0] / 2), WALL_TYPES.has(o.type) ? 1.4 : o.size[1] / 2, room.bounds.min[2] + o.size[2] / 2 + 0.1];
    x += o.size[0] + 0.25;
  }
  room.ai = { roomType: clean(ai.roomType, 30) || 'room', summary: clean(ai.summary, 240), model: MODEL, at: Date.now() };
  if (/^Room \d+$/.test(room.name) && ai.roomName) room.name = clean(ai.roomName, 40);
}

async function callClaude(key, content) {
  const r = await fetch(`${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 4096, system: SYSTEM, messages: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(150000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `Claude API error ${r.status}`);
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error('Claude did not return JSON');
  return JSON.parse(text.slice(s, e + 1));
}

app.post('/api/houses/:id/rooms/:rid/detect', auth, wrap(async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY || req.get('x-claude-key');
  if (!key) return res.status(400).json({ error: 'No Claude API key. Set ANTHROPIC_API_KEY on the server, or add your key in Settings.' });
  const h = await getHouse(req, res); if (!h) return;
  const room = h.rooms.find((r) => r.id === req.params.rid);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const heavy = await readJSON(roomFile(h.id, room.id), {});
  // up to 8 photos for Claude: headset photos spread around the room + the newest phone photos
  const all = heavy.photos || [];
  const posed = all.filter((p) => p.pose), phone = all.filter((p) => !p.pose).slice(-4);
  const nPosed = Math.min(posed.length, 8 - phone.length);
  const spread = nPosed <= 1 ? posed.slice(0, nPosed) : Array.from({ length: nPosed }, (_, i) => posed[Math.round((i * (posed.length - 1)) / (nPosed - 1))]);
  const photos = [...spread, ...phone];
  const content = [];
  photos.forEach((ph, i) => {
    let info = `Photo ${i}: phone photo, no position info.`;
    if (ph.pose) {
      const fwd = rotq(ph.pose.q, [0, 0, -1]);
      info = `Photo ${i}: headset camera at ${fv(ph.pose.p)} looking toward direction ${fv(fwd)}, horizontal FOV ≈ ${Math.round(ph.hfov || 76)}°.`;
    }
    content.push({ type: 'text', text: info });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: ph.data } });
  });
  content.push({ type: 'text', text: buildPrompt(room, photos) });
  let ai;
  try { ai = await callClaude(key, content); } catch (e) { return res.status(502).json({ error: e.message }); }
  const out = await editRoom(req, res, async (house, r) => { applyDetection(r, ai, photos); return r; });
  if (out) res.json(out);
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.type === 'entity.too.large' ? 'Upload too large' : err.message || 'Server error' });
});

app.listen(PORT, () => console.log(`HomeScan running on http://localhost:${PORT} (data: ${DATA_DIR}, model: ${MODEL})`));
