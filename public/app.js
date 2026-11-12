// MPARADISE HomeScan — client (three.js + WebXR)
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';

const $ = (s) => document.querySelector(s);
const S = {
  token: localStorage.getItem('hs_token'), user: localStorage.getItem('hs_user'), config: {},
  houses: [], house: null, roomId: null, view: 'dollhouse', layoutDirty: false,
  showLabels: true, showMesh: true, showModels: true, cutaway: true,
  support: { ar: false, vr: false }, xrMode: null, scan: null, camStream: null, camVideo: null, hudForce: 0,
};

// ---------- helpers ----------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
let toastT;
function toast(msg, ms = 3500) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
function toB64(typed) {
  const u8 = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength); let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b64, Type) { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return new Type(u8.buffer); }

async function api(method, url, body, withKey = false) {
  const headers = { 'content-type': 'application/json' };
  if (S.token) headers.authorization = 'Bearer ' + S.token;
  const key = localStorage.getItem('hs_claude_key');
  if (withKey && key) headers['x-claude-key'] = key;
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && S.token) { logout(); throw new Error('Signed out — please sign in again'); }
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

// ---------- screens ----------
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => (s.hidden = s.id !== id));
  $('#userbar').hidden = !S.token; $('#who').textContent = S.user || '';
  if (id === 'house') requestAnimationFrame(onResize);
}
function logout() { S.token = null; S.user = null; localStorage.removeItem('hs_token'); localStorage.removeItem('hs_user'); location.hash = ''; show('auth'); }

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const mode = e.submitter?.value === 'register' ? 'register' : 'login';
  try {
    const d = await api('POST', '/api/' + mode, { username: $('#username').value, password: $('#password').value });
    S.token = d.token; S.user = d.username;
    localStorage.setItem('hs_token', d.token); localStorage.setItem('hs_user', d.username);
    loadHouses();
  } catch (err) { toast(err.message); }
});
$('#btnLogout').onclick = logout;
$('#btnBack').onclick = () => { location.hash = ''; loadHouses(); };

async function loadHouses() {
  show('houses');
  try { S.houses = await api('GET', '/api/houses'); } catch (e) { return toast(e.message); }
  const list = $('#houseList'); list.replaceChildren();
  if (!S.houses.length) list.append(h('p', { class: 'muted' }, 'No houses yet — add one, then scan its rooms with your Quest.'));
  for (const hs of S.houses) {
    list.append(h('div', { class: 'card', onclick: () => openHouse(hs.id) },
      h('div', { class: 'ico' }, '🏠'), h('h3', {}, hs.name),
      h('div', { class: 'muted small' }, `${hs.rooms} rooms · ${hs.items} items · updated ${new Date(hs.updatedAt).toLocaleDateString()}`),
      h('div', { class: 'muted small' }, hs.roomNames.join(', ') || 'No rooms scanned yet'),
      h('div', { class: 'row' },
        h('button', { class: 'primary' }, 'Open'),
        h('button', { class: 'danger', onclick: async (ev) => {
          ev.stopPropagation();
          if (!confirm(`Delete "${hs.name}" and all its scans?`)) return;
          await api('DELETE', '/api/houses/' + hs.id).catch((er) => toast(er.message)); loadHouses();
        } }, 'Delete'))));
  }
}
$('#newHouse').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { const hs = await api('POST', '/api/houses', { name: $('#newHouseName').value }); $('#newHouseName').value = ''; openHouse(hs.id); } catch (er) { toast(er.message); }
});

async function openHouse(id) {
  try { S.house = await api('GET', '/api/houses/' + id); } catch (e) { toast(e.message); return loadHouses(); }
  S.roomId = S.house.rooms[0]?.id || null; S.layoutDirty = false;
  location.hash = 'house/' + id;
  $('#houseName').textContent = S.house.name;
  show('house');
  buildHouse();
  setView(S.view === 'walk' ? 'dollhouse' : S.view);
}
$('#houseName').onclick = async () => {
  const name = prompt('House name', S.house.name); if (!name) return;
  await api('PATCH', '/api/houses/' + S.house.id, { name }).catch((e) => toast(e.message));
  S.house.name = name; $('#houseName').textContent = name;
};

// ---------- settings ----------
$('#btnSettings').onclick = () => {
  $('#serverKeyInfo').textContent = S.config.claudeServerKey ? `✅ The server has a Claude API key (model: ${S.config.model}). You don't need to add one.` : `No Claude key on the server yet (model: ${S.config.model || '?'}). Add ANTHROPIC_API_KEY on your server, or paste a key below.`;
  $('#claudeKey').value = localStorage.getItem('hs_claude_key') || '';
  $('#settingsDlg').showModal();
};
$('#btnSaveSettings').onclick = () => { const k = $('#claudeKey').value.trim(); k ? localStorage.setItem('hs_claude_key', k) : localStorage.removeItem('hs_claude_key'); $('#settingsDlg').close(); toast('Saved'); };
$('#btnCloseSettings').onclick = () => $('#settingsDlg').close();

// ---------- 3D core ----------
const viewport = $('#viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
viewport.prepend(renderer.domElement);

const camera = new THREE.PerspectiveCamera(65, 1, 0.03, 300);
const rig = new THREE.Group(); rig.add(camera);
const SKY = new THREE.Color(0x0b1220);
const houseScene = new THREE.Scene(); houseScene.background = SKY;
houseScene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.5); sun.position.set(5, 10, 4); houseScene.add(sun);
const grid = new THREE.GridHelper(80, 80, 0x1f3b57, 0x13253a); grid.position.y = -0.02; houseScene.add(grid);
const houseRoot = new THREE.Group(); houseScene.add(houseRoot);
houseScene.add(rig);
const scanScene = new THREE.Scene();
const scanRoot = new THREE.Group(); scanScene.add(scanRoot);
let activeScene = houseScene;
const cutPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 2.1);
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.49;
const raycaster = new THREE.Raycaster();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

function onResize() {
  if (renderer.xr.isPresenting) return;
  const w = viewport.clientWidth || 1, hh = viewport.clientHeight || 1;
  renderer.setSize(w, hh, false); camera.aspect = w / hh; camera.updateProjectionMatrix();
}
new ResizeObserver(onResize).observe(viewport);

const shared = (m) => { m.userData.shared = true; return m; };
const MAT = {
  floor: shared(new THREE.MeshStandardMaterial({ color: 0xc8b496, roughness: 0.9, side: THREE.DoubleSide })),
  floorSel: shared(new THREE.MeshStandardMaterial({ color: 0x5fd6c6, roughness: 0.9, side: THREE.DoubleSide })),
  wall: shared(new THREE.MeshStandardMaterial({ color: 0xe9edf2, roughness: 0.95, side: THREE.DoubleSide })),
  ceiling: shared(new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 1, side: THREE.DoubleSide })),
  door: shared(new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.8, side: THREE.DoubleSide })),
  window: shared(new THREE.MeshStandardMaterial({ color: 0x93c5fd, transparent: true, opacity: 0.45, side: THREE.DoubleSide })),
  scan: shared(new THREE.MeshStandardMaterial({ color: 0xd9d4cc, roughness: 1, flatShading: true, side: THREE.DoubleSide })),
};

function disposeTree(g) {
  g.traverse((o) => {
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) { m.map?.dispose(); if (!m.userData.shared) m.dispose(); }
  });
}

function textSprite(text, height = 0.1, bg = 'rgba(8,20,38,0.85)') {
  const c = document.createElement('canvas'); const ctx = c.getContext('2d'); const fs = 44;
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  c.width = Math.ceil(ctx.measureText(text).width) + 36; c.height = fs + 26;
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(0, 0, c.width, c.height, 18) : ctx.rect(0, 0, c.width, c.height); ctx.fill();
  ctx.fillStyle = '#eafffb'; ctx.textBaseline = 'middle'; ctx.fillText(text, 18, c.height / 2 + 2);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  sp.scale.set((height * c.width) / c.height, height, 1); sp.renderOrder = 5;
  return sp;
}

function polygonGeometry(pts) {
  const v = pts.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
  const n = new THREE.Vector3();
  for (let i = 0; i < v.length; i++) {
    const a = v[i], b = v[(i + 1) % v.length];
    n.x += (a.y - b.y) * (a.z + b.z); n.y += (a.z - b.z) * (a.x + b.x); n.z += (a.x - b.x) * (a.y + b.y);
  }
  if (n.lengthSq() < 1e-9) n.set(0, 1, 0);
  n.normalize();
  const u = (Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).cross(n).normalize();
  const w = n.clone().cross(u);
  const tris = THREE.ShapeUtils.triangulateShape(v.map((p) => new THREE.Vector2(p.dot(u), p.dot(w))), []);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(v.flatMap((p) => [p.x, p.y, p.z]), 3));
  geo.setIndex(tris.flat());
  geo.computeVertexNormals();
  return geo;
}
function polyArea(pts) { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[2] - q[0] * p[2]; } return Math.abs(a / 2); }
function area3(pts) {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; x += (a[1] - b[1]) * (a[2] + b[2]); y += (a[2] - b[2]) * (a[0] + b[0]); z += (a[0] - b[0]) * (a[1] + b[1]); }
  return Math.hypot(x, y, z) / 2;
}
const planeKind = (l = '') => (/floor/.test(l) ? 'floor' : /ceiling/.test(l) ? 'ceiling' : /door/.test(l) ? 'door' : /window/.test(l) ? 'window' : /wall/.test(l) && !/art/.test(l) ? 'wall' : l);

// ---------- furniture models ----------
const FTYPES = ['sofa', 'armchair', 'chair', 'table', 'desk', 'bed', 'cabinet', 'shelf', 'wardrobe', 'tv', 'lamp', 'plant', 'rug', 'wall_art', 'appliance', 'door', 'window', 'other'];
const DEFAULT_COLORS = { sofa: '#6b7280', armchair: '#8b7355', chair: '#a0785a', table: '#9c6b3c', desk: '#b08a5a', bed: '#cbd5e1', cabinet: '#a8a29e', shelf: '#92673f', wardrobe: '#d6d3d1', tv: '#111827', lamp: '#f5f5f4', plant: '#3f8f4f', rug: '#b45309', wall_art: '#60a5fa', appliance: '#e5e7eb', door: '#8b5a2b', window: '#93c5fd', other: '#94a3b8' };
const FACE_WALL = new Set(['sofa', 'armchair', 'bed', 'cabinet', 'shelf', 'wardrobe', 'tv', 'desk', 'appliance']);
const LONG_FRONT = new Set(['sofa', 'armchair', 'desk', 'tv', 'cabinet', 'shelf', 'wardrobe', 'appliance', 'table']);

function furnitureModel(type, w, h, d, color) {
  const g = new THREE.Group();
  const c = new THREE.Color(color);
  const mat = new THREE.MeshStandardMaterial({ color: c, roughness: 0.75 });
  const dark = new THREE.MeshStandardMaterial({ color: c.clone().multiplyScalar(0.62), roughness: 0.8 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x5b4636, roughness: 0.7 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.9 });
  const box = (bw, bh, bd, x, y, z, m = mat) => { const me = new THREE.Mesh(new THREE.BoxGeometry(Math.max(bw, 0.01), Math.max(bh, 0.01), Math.max(bd, 0.01)), m); me.position.set(x, y, z); g.add(me); return me; };
  const cyl = (rt, rb, hh, y, m = mat) => { const me = new THREE.Mesh(new THREE.CylinderGeometry(Math.max(rt, 0.005), Math.max(rb, 0.005), Math.max(hh, 0.01), 20), m); me.position.y = y; g.add(me); return me; };
  const legs = (top, inset, t, m) => { for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(t, top, t, sx * (w / 2 - inset), top / 2, sz * (d / 2 - inset), m); };
  switch (type) {
    case 'sofa': case 'armchair': {
      const seatH = Math.min(0.45, h * 0.5), arm = Math.min(0.2, w * 0.15), back = Math.min(0.25, d * 0.3);
      box(w, seatH * 0.8, d, 0, seatH * 0.4, 0, dark);
      box(w - 2 * arm, seatH * 0.25, d - back, 0, seatH * 0.925, back / 2);
      box(w, h, back, 0, h / 2, -d / 2 + back / 2);
      for (const s of [-1, 1]) box(arm, h * 0.68, d, s * (w / 2 - arm / 2), h * 0.34, 0);
      break;
    }
    case 'chair': {
      const seatH = Math.min(0.47, h * 0.5);
      box(w, 0.05, d, 0, seatH, 0);
      legs(seatH, 0.04, 0.04, wood);
      box(w, h - seatH, 0.05, 0, seatH + (h - seatH) / 2, -d / 2 + 0.025);
      break;
    }
    case 'table': case 'desk': {
      box(w, 0.04, d, 0, h - 0.02, 0);
      legs(h - 0.04, 0.05, 0.05, dark);
      if (type === 'desk') { const dw = Math.min(0.45, w * 0.35); box(dw, h * 0.55, d * 0.9, w / 2 - dw / 2 - 0.03, h - 0.04 - h * 0.275, 0, dark); }
      break;
    }
    case 'bed': {
      const baseH = Math.min(h * 0.6, 0.35), head = Math.max(h + 0.45, 0.95);
      box(w, baseH, d, 0, baseH / 2, 0, wood);
      box(w - 0.04, h - baseH, d - 0.06, 0, baseH + (h - baseH) / 2, 0.01, white);
      box(w, head, 0.08, 0, head / 2, -d / 2 + 0.04, wood);
      for (const s of w > 1.2 ? [-1, 1] : [0]) box(w > 1.2 ? w * 0.4 : w * 0.75, 0.12, 0.35, s * w * 0.23, h + 0.06, -d / 2 + 0.3, white);
      box(w + 0.02, 0.06, d * 0.62, 0, h + 0.01, d / 2 - d * 0.31, mat);
      break;
    }
    case 'shelf': {
      for (const s of [-1, 1]) box(0.03, h, d, s * (w / 2 - 0.015), h / 2, 0);
      const n = Math.max(2, Math.round(h / 0.38));
      for (let i = 0; i <= n; i++) box(w, 0.025, d, 0, Math.min(h - 0.0125, 0.0125 + (i * (h - 0.025)) / n), 0);
      box(w, h, 0.01, 0, h / 2, -d / 2 + 0.005, dark);
      break;
    }
    case 'cabinet': case 'wardrobe': case 'appliance': {
      box(w, h, d, 0, h / 2, 0);
      box(0.012, h * 0.92, 0.01, 0, h / 2, d / 2 + 0.005, dark);
      for (const s of [-1, 1]) box(0.02, Math.min(0.15, h * 0.2), 0.02, s * 0.05, h * 0.55, d / 2 + 0.015, dark);
      break;
    }
    case 'tv': {
      const t = clamp(d, 0.03, 0.08);
      box(w, h, t, 0, h / 2, 0, new THREE.MeshStandardMaterial({ color: 0x0b0f19, roughness: 0.3 }));
      box(w * 0.95, h * 0.92, 0.005, 0, h / 2, t / 2 + 0.003, new THREE.MeshStandardMaterial({ color: 0x111c33, emissive: 0x0d2a4a, emissiveIntensity: 0.7, roughness: 0.2 }));
      break;
    }
    case 'lamp': {
      const r = Math.min(w, d) / 2;
      cyl(r * 0.6, r * 0.7, 0.04, 0.02, dark);
      cyl(0.015, 0.015, h * 0.8, h * 0.4, dark);
      cyl(r * 0.55, r, h * 0.22, h * 0.89, new THREE.MeshStandardMaterial({ color: c, emissive: 0xfff1c1, emissiveIntensity: 0.5, side: THREE.DoubleSide }));
      break;
    }
    case 'plant': {
      const r = Math.min(w, d) / 2;
      cyl(r * 0.6, r * 0.45, h * 0.3, h * 0.15, new THREE.MeshStandardMaterial({ color: 0x9a5b3c }));
      const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: c, flatShading: true }));
      leaf.scale.set(w / 2, h * 0.38, d / 2); leaf.position.y = h * 0.66; g.add(leaf);
      break;
    }
    case 'rug': box(w, 0.015, d, 0, 0.0075, 0); break;
    case 'wall_art': box(w, h, clamp(d, 0.02, 0.05), 0, h / 2, 0); break;
    case 'door': box(w, h, clamp(d, 0.04, 0.08), 0, h / 2, 0); break;
    case 'window': box(w, h, 0.03, 0, h / 2, 0, new THREE.MeshStandardMaterial({ color: c, transparent: true, opacity: 0.45 })); break;
    default: box(w, h, d, 0, h / 2, 0);
  }
  return g;
}

function buildFurniture(o, bounds) {
  const type = o.type || 'other';
  const [w, h, d] = o.size.map((v) => Math.max(0.02, +v || 0.3));
  const swap = (LONG_FRONT.has(type) && d > w * 1.15) || (type === 'bed' && w > d * 1.15);
  const mw = swap ? d : w, md = swap ? w : d;
  const inner = furnitureModel(type, mw, h, md, o.color || DEFAULT_COLORS[type] || '#94a3b8');
  let rot = swap ? Math.PI / 2 : 0;
  const g = new THREE.Group(); g.add(inner);
  const [cx, cy, cz] = o.center; const yaw = o.yaw || 0;
  g.position.set(cx, Math.max(0, cy - h / 2), cz); g.rotation.y = yaw;
  if (bounds && FACE_WALL.has(type)) { // put the back against the nearest wall
    const a = yaw + rot, fx = Math.sin(a), fz = Math.cos(a);
    const dist = (x, z) => Math.min(x - bounds.min[0], bounds.max[0] - x, z - bounds.min[2], bounds.max[2] - z);
    if (dist(cx + (fx * md) / 2, cz + (fz * md) / 2) < dist(cx - (fx * md) / 2, cz - (fz * md) / 2)) rot += Math.PI;
  }
  if (o.flip) rot += Math.PI;
  inner.rotation.y = rot;
  return g;
}

// ---------- house scene ----------
const roomGroups = new Map();
const findRoom = (id) => S.house?.rooms.find((r) => r.id === id);

function buildRoom(room) {
  const g = new THREE.Group(); g.userData.roomId = room.id;
  const t = room.transform || { x: 0, z: 0, rot: 0 };
  g.position.set(t.x, 0, t.z); g.rotation.y = t.rot || 0;
  const b = room.bounds;
  const parts = { walls: [], ceilings: [], models: [], labels: [], mesh: null, roomLabel: null };
  const floors = (room.planes || []).filter((p) => planeKind(p.label) === 'floor').sort((a, c) => polyArea(c.points) - polyArea(a.points));
  const fpts = floors[0] ? floors[0].points.map((p) => [p[0], 0, p[2]]) : [[b.min[0], 0, b.min[2]], [b.max[0], 0, b.min[2]], [b.max[0], 0, b.max[2]], [b.min[0], 0, b.max[2]]];
  const floor = new THREE.Mesh(polygonGeometry(fpts), MAT.floor);
  floor.position.y = -0.006; floor.userData.floorOf = room.id; g.add(floor); g.userData.floor = floor;
  for (const pl of room.planes || []) {
    const kind = planeKind(pl.label);
    const mat = { wall: MAT.wall, ceiling: MAT.ceiling, door: MAT.door, window: MAT.window }[kind];
    if (!mat) continue;
    let pts = pl.points;
    if (kind === 'door' || kind === 'window') { // nudge toward the room centre so it doesn't z-fight with the wall
      const n = pl.normal || [0, 0, 0]; const p0 = pts[0];
      const s = Math.sign(-p0[0] * n[0] - p0[2] * n[2]) || 1;
      pts = pts.map((p) => [p[0] + n[0] * 0.015 * s, p[1], p[2] + n[2] * 0.015 * s]);
    }
    const m = new THREE.Mesh(polygonGeometry(pts), mat); g.add(m);
    if (kind === 'wall') parts.walls.push(m);
    if (kind === 'ceiling') parts.ceilings.push(m);
  }
  if (room.mesh?.positions) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(fromB64(room.mesh.positions, Float32Array), 3));
    geo.setIndex(new THREE.BufferAttribute(fromB64(room.mesh.indices, Uint32Array), 1));
    geo.computeVertexNormals();
    parts.mesh = new THREE.Mesh(geo, MAT.scan); g.add(parts.mesh);
  }
  for (const o of room.objects || []) {
    if (!o.center || !o.size) continue;
    const f = buildFurniture(o, b); g.add(f); parts.models.push(f);
    const lbl = textSprite((o.approx ? '≈ ' : '') + (o.name || o.type), 0.085);
    lbl.position.set(o.center[0], o.center[1] + o.size[1] / 2 + 0.12, o.center[2]); g.add(lbl); parts.labels.push(lbl);
  }
  parts.roomLabel = textSprite(room.name, 0.2, 'rgba(13,148,136,0.92)'); parts.roomLabel.position.set(0, 1.95, 0); g.add(parts.roomLabel);
  g.userData.parts = parts;
  return g;
}
function addRoomGroup(room) { const g = buildRoom(room); roomGroups.set(room.id, g); houseRoot.add(g); }
function buildHouse() {
  for (const g of roomGroups.values()) { houseRoot.remove(g); disposeTree(g); }
  roomGroups.clear();
  for (const r of S.house.rooms) addRoomGroup(r);
  applyVisibility();
}
function rebuildRoom(room) { const old = roomGroups.get(room.id); if (old) { houseRoot.remove(old); disposeTree(old); } addRoomGroup(room); applyVisibility(); }
function applyVisibility() {
  const walk = S.xrMode === 'walk' || (S.view === 'walk' && !S.xrMode);
  for (const [id, g] of roomGroups) {
    const p = g.userData.parts; const meshOn = !!p.mesh && S.showMesh;
    if (p.mesh) p.mesh.visible = S.showMesh;
    p.walls.forEach((m) => (m.visible = !meshOn));
    p.ceilings.forEach((m) => (m.visible = !meshOn && walk));
    p.models.forEach((m) => (m.visible = S.showModels));
    p.labels.forEach((m) => (m.visible = S.showModels && S.showLabels));
    p.roomLabel.visible = !walk;
    g.userData.floor.material = id === S.roomId && !walk ? MAT.floorSel : MAT.floor;
  }
  renderer.clippingPlanes = !walk && S.cutaway && !S.xrMode ? [cutPlane] : [];
}
const floorMeshes = () => [...roomGroups.values()].map((g) => g.userData.floor);
function roomAt(pos) {
  for (const [id, g] of roomGroups) {
    const l = g.worldToLocal(_v3.copy(pos)); const b = findRoom(id)?.bounds;
    if (b && l.x >= b.min[0] && l.x <= b.max[0] && l.z >= b.min[2] && l.z <= b.max[2]) return findRoom(id);
  }
  return null;
}

// ---------- desktop views ----------
function houseBox() {
  houseRoot.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const g of roomGroups.values()) box.expandByObject(g.userData.floor);
  if (box.isEmpty()) box.set(new THREE.Vector3(-3, 0, -3), new THREE.Vector3(3, 0, 3));
  return box;
}
const walkCam = { yaw: 0, pitch: 0, keys: new Set(), target: null };
function setView(v) {
  S.view = v;
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  const box = houseBox(), c = box.getCenter(new THREE.Vector3()), size = Math.max(box.max.x - box.min.x, box.max.z - box.min.z, 4);
  camera.up.set(0, 1, 0);
  if (v === 'dollhouse') { controls.enabled = true; controls.enableRotate = true; camera.position.set(c.x + size * 0.55, size * 0.85 + 2.5, c.z + size * 0.85 + 1.5); controls.target.set(c.x, 0, c.z); controls.update(); }
  if (v === 'plan') { controls.enabled = true; controls.enableRotate = false; camera.position.set(c.x, size * 1.25 + 4, c.z + 0.001); controls.target.set(c.x, 0, c.z); controls.update(); }
  if (v === 'walk') {
    controls.enabled = false;
    const g = roomGroups.get(S.roomId) || [...roomGroups.values()][0];
    camera.position.set(g ? g.position.x : c.x, 1.6, g ? g.position.z : c.z);
    walkCam.yaw = 0; walkCam.pitch = -0.1; walkCam.target = null; camera.rotation.set(walkCam.pitch, walkCam.yaw, 0, 'YXZ');
  }
  $('#hint').textContent = { dollhouse: 'Drag to orbit · scroll/pinch to zoom · click a room to select it', plan: 'Drag rooms to line them up · use the rotate buttons on the right · then Save layout', walk: 'Drag to look · WASD/arrows to walk · click/tap the floor to go there' }[v];
  applyVisibility(); renderSide();
}
document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => setView(b.dataset.view)));

function ndc(e) { const r = renderer.domElement.getBoundingClientRect(); return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); }
function pickFloor(e) { raycaster.setFromCamera(ndc(e), camera); const hit = raycaster.intersectObjects(floorMeshes(), false)[0]; return hit ? { roomId: hit.object.userData.floorOf, point: hit.point } : null; }
function groundPoint(e) { raycaster.setFromCamera(ndc(e), camera); const p = new THREE.Vector3(); return raycaster.ray.intersectPlane(groundPlane, p) ? p : null; }
const snap5 = (v) => Math.round(v / 0.05) * 0.05;
let ptr = null, drag = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  ptr = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, moved: false };
  if (S.view === 'plan') {
    const hit = pickFloor(e);
    if (hit) {
      selectRoom(hit.roomId); const g = roomGroups.get(hit.roomId);
      drag = { g, room: findRoom(hit.roomId), off: hit.point.clone().sub(g.position) };
      controls.enabled = false; renderer.domElement.setPointerCapture(e.pointerId);
    }
  }
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!ptr) return;
  const dx = e.clientX - ptr.lx, dy = e.clientY - ptr.ly; ptr.lx = e.clientX; ptr.ly = e.clientY;
  if (Math.hypot(e.clientX - ptr.x, e.clientY - ptr.y) > 6) ptr.moved = true;
  if (drag) { const p = groundPoint(e); if (p) { drag.g.position.x = snap5(p.x - drag.off.x); drag.g.position.z = snap5(p.z - drag.off.z); } }
  else if (S.view === 'walk') { walkCam.yaw -= dx * 0.005; walkCam.pitch = clamp(walkCam.pitch - dy * 0.005, -1.3, 1.3); camera.rotation.set(walkCam.pitch, walkCam.yaw, 0, 'YXZ'); }
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (drag) {
    drag.room.transform = { x: drag.g.position.x, z: drag.g.position.z, rot: drag.g.rotation.y };
    if (ptr?.moved) { S.layoutDirty = true; renderSide(); }
    drag = null; controls.enabled = true;
  } else if (ptr && !ptr.moved) {
    const hit = pickFloor(e);
    if (hit) { if (S.view === 'walk') walkCam.target = hit.point.clone(); else selectRoom(hit.roomId); }
  }
  ptr = null;
});
addEventListener('keydown', (e) => { if (!/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) walkCam.keys.add(e.key.toLowerCase()); });
addEventListener('keyup', (e) => walkCam.keys.delete(e.key.toLowerCase()));
function desktopWalk(dt) {
  const k = walkCam.keys, f = _v1.set(-Math.sin(walkCam.yaw), 0, -Math.cos(walkCam.yaw)), r = _v2.set(-f.z, 0, f.x);
  const mx = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
  const mz = (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0);
  if (mx || mz) { walkCam.target = null; camera.position.addScaledVector(f, mz * 2 * dt).addScaledVector(r, mx * 2 * dt); }
  else if (walkCam.target) {
    const d = _v3.set(walkCam.target.x - camera.position.x, 0, walkCam.target.z - camera.position.z);
    const len = d.length(); if (len < 0.05) walkCam.target = null; else camera.position.addScaledVector(d.normalize(), Math.min(len, 2.2 * dt));
  }
  camera.position.y = 1.6;
}
function selectRoom(id) { S.roomId = id; applyVisibility(); renderSide(); }

// ---------- side panel ----------
let saveTimer;
function saveObjects(room) { clearTimeout(saveTimer); saveTimer = setTimeout(() => api('PATCH', `/api/houses/${S.house.id}/rooms/${room.id}`, { objects: room.objects }).catch((e) => toast(e.message)), 500); }
function editObj(room, o, patch) {
  if (patch === null) room.objects = room.objects.filter((x) => x !== o); else Object.assign(o, patch);
  rebuildRoom(room); saveObjects(room); if (patch === null || 'type' in patch) renderSide();
}
function furnRow(room, o) {
  return h('div', { class: 'furn' + (o.approx ? ' approx' : ''), title: o.approx ? 'Position estimated by Claude from a photo' : o.label ? `Headset label: ${o.label}` : '' },
    h('input', { type: 'color', value: o.color || DEFAULT_COLORS[o.type] || '#94a3b8', onchange: (e) => editObj(room, o, { color: e.target.value }) }),
    h('input', { value: o.name || '', onchange: (e) => editObj(room, o, { name: e.target.value }) }),
    h('select', { onchange: (e) => editObj(room, o, { type: e.target.value }) }, FTYPES.map((t) => h('option', { value: t, selected: t === o.type }, t))),
    h('button', { title: 'Turn around', onclick: () => editObj(room, o, { flip: !o.flip }) }, '↻'),
    h('button', { title: 'Remove', onclick: () => editObj(room, o, null) }, '✕'));
}
function renderSide() {
  const side = $('#side'); side.replaceChildren(); if (!S.house) return;
  const rooms = S.house.rooms;
  side.append(h('h4', {}, `Rooms (${rooms.length})`));
  if (!rooms.length) side.append(h('p', { class: 'muted small' }, S.support.ar ? 'Press “Scan a room” while standing in a room.' : 'Open this site in the Meta Quest Browser to scan rooms. Saved houses open on any device.'));
  for (const r of rooms) side.append(h('div', { class: 'room' + (r.id === S.roomId ? ' active' : ''), onclick: () => selectRoom(r.id) }, h('b', {}, r.name), h('span', { class: 'muted small' }, `${r.ai?.roomType || 'not analysed yet'} · ${r.objects.length} items · ${r.photoCount || 0} photos`)));
  const room = findRoom(S.roomId);
  if (room) {
    side.append(h('div', { class: 'row wrap', style: 'margin:8px 0' },
      h('button', { onclick: () => renameRoom(room) }, '✏️ Rename'),
      h('button', { onclick: () => detectRoom(room) }, '🤖 Detect again'),
      h('label', { class: 'btn' }, '📷 Add photos', h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: (e) => addPhotos(room, e.target.files) })),
      h('button', { class: 'danger', onclick: () => deleteRoom(room) }, '🗑')));
    if (room.ai?.summary) side.append(h('p', { class: 'muted small' }, '🤖 ' + room.ai.summary));
    if (S.view === 'plan') {
      const rot = (d) => { const g = roomGroups.get(room.id); g.rotation.y += d; room.transform = { x: g.position.x, z: g.position.z, rot: g.rotation.y }; S.layoutDirty = true; renderSide(); };
      side.append(h('h4', {}, 'Layout'), h('div', { class: 'row wrap' },
        h('button', { onclick: () => rot(Math.PI / 2) }, '⟲ 90°'), h('button', { onclick: () => rot(Math.PI / 36) }, '⟲ 5°'),
        h('button', { onclick: () => rot(-Math.PI / 36) }, '⟳ 5°'), h('button', { onclick: () => rot(-Math.PI / 2) }, '⟳ 90°'),
        h('button', { class: 'primary', disabled: !S.layoutDirty, onclick: saveLayout }, '💾 Save layout')));
    }
    side.append(h('h4', {}, `Furniture (${room.objects.length})`));
    if (!room.objects.length) side.append(h('p', { class: 'muted small' }, 'No furniture yet. Try “Detect again” or add photos so Claude can see the room.'));
    for (const o of room.objects) side.append(furnRow(room, o));
  }
  const tog = (label, key) => h('label', {}, h('input', { type: 'checkbox', checked: S[key], onchange: (e) => { S[key] = e.target.checked; applyVisibility(); } }), label);
  side.append(h('h4', {}, 'Show'), h('div', { class: 'toggles' }, tog('Furniture models', 'showModels'), tog('Labels', 'showLabels'), tog('Real scan mesh', 'showMesh'), tog('Cut away ceiling (dollhouse)', 'cutaway')));
}
async function saveLayout() {
  try { await api('PATCH', '/api/houses/' + S.house.id, { rooms: S.house.rooms.map((r) => ({ id: r.id, transform: r.transform })) }); S.layoutDirty = false; renderSide(); toast('Layout saved'); } catch (e) { toast(e.message); }
}
async function renameRoom(room) {
  const name = prompt('Room name', room.name); if (!name) return;
  try { Object.assign(room, await api('PATCH', `/api/houses/${S.house.id}/rooms/${room.id}`, { name })); rebuildRoom(room); renderSide(); } catch (e) { toast(e.message); }
}
async function deleteRoom(room) {
  if (!confirm(`Delete ${room.name}?`)) return;
  try { await api('DELETE', `/api/houses/${S.house.id}/rooms/${room.id}`); } catch (e) { return toast(e.message); }
  S.house.rooms = S.house.rooms.filter((r) => r !== room);
  const g = roomGroups.get(room.id); if (g) { houseRoot.remove(g); disposeTree(g); roomGroups.delete(room.id); }
  S.roomId = S.house.rooms[0]?.id || null; applyVisibility(); renderSide();
}
async function detectRoom(room) {
  toast('🤖 Claude is looking at the room…', 120000);
  try {
    const upd = await api('POST', `/api/houses/${S.house.id}/rooms/${room.id}/detect`, {}, true);
    const mesh = room.mesh; Object.assign(room, upd); room.mesh = mesh;
    rebuildRoom(room); renderSide();
    toast(`🤖 ${room.name}: ${room.objects.length} items — ${room.objects.slice(0, 5).map((o) => o.name).join(', ')}`, 7000);
  } catch (e) { toast('Claude: ' + e.message, 7000); }
}
function fileToJpeg(file, max = 1024) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src); res(c.toDataURL('image/jpeg', 0.82).split(',')[1]);
    };
    img.onerror = rej; img.src = URL.createObjectURL(file);
  });
}
async function addPhotos(room, files) {
  if (!files?.length) return;
  try {
    const images = []; for (const f of [...files].slice(0, 8)) images.push(await fileToJpeg(f));
    const r = await api('POST', `/api/houses/${S.house.id}/rooms/${room.id}/photos`, { images }); room.photoCount = r.photoCount;
    detectRoom(room);
  } catch (e) { toast(e.message); }
}

// ---------- XR: controllers, hands, HUD ----------
const cmf = new XRControllerModelFactory(), hmf = new XRHandModelFactory();
const ctrls = [0, 1].map((i) => {
  const c = renderer.xr.getController(i);
  const ray = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0x5eead4, transparent: true, opacity: 0.85 }));
  ray.scale.z = 3; c.add(ray); c.userData.ray = ray;
  c.addEventListener('connected', (e) => (c.userData.src = e.data));
  c.addEventListener('disconnected', () => (c.userData.src = null));
  c.addEventListener('selectstart', () => xrSelectStart(c));
  c.addEventListener('selectend', () => xrSelectEnd(c));
  rig.add(c);
  const grip = renderer.xr.getControllerGrip(i); grip.add(cmf.createControllerModel(grip)); rig.add(grip);
  const hand = renderer.xr.getHand(i); hand.add(hmf.createHandModel(hand, 'mesh')); rig.add(hand);
  return c;
});
const tpMarker = new THREE.Mesh(new THREE.RingGeometry(0.18, 0.25, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x5eead4 }));
tpMarker.visible = false;

function canvasPlane(w, hgt, ppm = 1000) {
  const c = document.createElement('canvas'); c.width = Math.round(w * ppm); c.height = Math.round(hgt * ppm);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, hgt), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false }));
  m.renderOrder = 20; m.userData = { canvas: c, ctx: c.getContext('2d'), tex };
  return m;
}
function rr(ctx, x, y, w, hh, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, hh, r); else ctx.rect(x, y, w, hh); }
function makeHud(defs) {
  const hud = new THREE.Group();
  const info = canvasPlane(0.62, 0.25); info.position.y = 0.15; hud.add(info);
  const buttons = defs.map((d, i) => {
    const b = canvasPlane(0.19, 0.07); b.position.set(((i % 3) - 1) * 0.205, -0.03 - Math.floor(i / 3) * 0.082, 0.002);
    b.userData.def = d; hud.add(b); return b;
  });
  const mini = canvasPlane(0.16, 0.06); mini.userData.def = { label: '☰ Menu', onClick: () => setMini(hud, false) }; mini.visible = false; hud.add(mini);
  hud.userData = { info, buttons, mini, yaw: null, key: '', isMini: false };
  return hud;
}
function setMini(hud, on) { hud.userData.isMini = on; hud.userData.info.visible = !on; hud.userData.buttons.forEach((b) => (b.visible = !on)); hud.userData.mini.visible = on; }
const hudButtons = (hud) => (hud ? [...hud.userData.buttons, hud.userData.mini].filter((b) => b.visible) : []);
function wrapText(ctx, text, maxW) {
  const out = []; let line = '';
  for (const word of String(text).split(' ')) { const t = line ? line + ' ' + word : word; if (ctx.measureText(t).width > maxW && line) { out.push(line); line = word; } else line = t; }
  if (line) out.push(line); return out;
}
function paintInfo(hud, title, lines) {
  const key = title + '\n' + lines.join('\n'); if (hud.userData.key === key) return; hud.userData.key = key;
  const { ctx, canvas, tex } = hud.userData.info.userData; const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H); ctx.fillStyle = 'rgba(11,18,32,0.9)'; rr(ctx, 0, 0, W, H, 34); ctx.fill();
  ctx.strokeStyle = '#14b8a6'; ctx.lineWidth = 4; rr(ctx, 2, 2, W - 4, H - 4, 32); ctx.stroke();
  ctx.fillStyle = '#5eead4'; ctx.font = '700 40px system-ui, sans-serif'; ctx.fillText(title, 28, 58);
  ctx.font = '28px system-ui, sans-serif'; let y = 104;
  for (const l of lines) for (const wl of wrapText(ctx, l, W - 56)) { if (y > H - 14) break; ctx.fillStyle = l.startsWith('⚠') ? '#fca5a5' : '#e6f1ff'; ctx.fillText(wl, 28, y); y += 36; }
  tex.needsUpdate = true;
}
function paintButton(b) {
  const d = b.userData.def; const label = typeof d.label === 'function' ? d.label() : d.label;
  const enabled = d.enabled ? d.enabled() : true; const key = `${label}|${b.userData.hover}|${enabled}`;
  if (b.userData.key === key) return; b.userData.key = key;
  const { ctx, canvas, tex } = b.userData; const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = !enabled ? 'rgba(40,52,75,0.85)' : b.userData.hover ? '#14b8a6' : 'rgba(26,42,74,0.95)'; rr(ctx, 0, 0, W, H, 22); ctx.fill();
  ctx.strokeStyle = '#14b8a6'; ctx.lineWidth = 3; rr(ctx, 1.5, 1.5, W - 3, H - 3, 21); ctx.stroke();
  ctx.fillStyle = !enabled ? '#6b7c99' : b.userData.hover ? '#04211d' : '#e6f1ff';
  ctx.font = '600 30px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, W / 2, H / 2 + 2); ctx.textAlign = 'left';
  tex.needsUpdate = true;
}
function followHud(hud, force) {
  const head = camera.getWorldPosition(_v1); const dir = camera.getWorldDirection(_v2); dir.y = 0;
  if (dir.lengthSq() < 1e-6) return; dir.normalize();
  const yaw = Math.atan2(dir.x, dir.z); const u = hud.userData;
  if (u.yaw === null || force || Math.abs(angDiff(yaw, u.yaw)) > 0.8) u.yaw = yaw;
  const target = _v3.set(head.x + Math.sin(u.yaw) * 0.6, head.y - 0.32, head.z + Math.cos(u.yaw) * 0.6);
  if (force) hud.position.copy(target); else hud.position.lerp(target, 0.07);
  hud.lookAt(head);
}
let hud = null;
function hudHit(c) {
  const btns = hudButtons(hud); if (!btns.length) return null;
  raycaster.setFromXRController(c);
  return raycaster.intersectObjects(btns, false)[0] || null;
}
function updateRays() {
  const btns = hudButtons(hud); btns.forEach((b) => (b.userData.hoverNow = false));
  for (const c of ctrls) {
    if (!c.userData.src) continue;
    const hit = hudHit(c); if (hit) hit.object.userData.hoverNow = true;
    c.userData.ray.scale.z = hit ? hit.distance : c.userData.aimDist || 3;
  }
  for (const b of btns) { b.userData.hover = !!b.userData.hoverNow; paintButton(b); }
}
function xrSelectStart(c) {
  const hit = hudHit(c);
  if (hit) { c.userData.consumed = true; const d = hit.object.userData.def; if (!d.enabled || d.enabled()) d.onClick(); return; }
  if (S.xrMode === 'scan' && S.scan?.tracing) { raycaster.setFromXRController(c); const p = new THREE.Vector3(); if (raycaster.ray.intersectPlane(groundPlane, p)) addTracePoint(p); }
  if (S.xrMode === 'walk') c.userData.aiming = true;
}
function xrSelectEnd(c) {
  if (S.xrMode === 'walk' && c.userData.aiming && !c.userData.consumed && c.userData.aimPoint) teleportTo(c.userData.aimPoint);
  c.userData.aiming = false; c.userData.consumed = false; c.userData.aimPoint = null; c.userData.aimDist = 0;
}

async function startXR(mode) {
  if (renderer.xr.isPresenting) return;
  const opts = mode === 'scan'
    ? { requiredFeatures: ['local-floor'], optionalFeatures: ['mesh-detection', 'plane-detection', 'hand-tracking', 'anchors'] }
    : { requiredFeatures: ['local-floor'], optionalFeatures: ['hand-tracking'] };
  let session;
  try { session = await navigator.xr.requestSession(mode === 'scan' ? 'immersive-ar' : 'immersive-vr', opts); } catch (e) { return toast('Could not start VR: ' + e.message, 6000); }
  S.xrMode = mode; controls.enabled = false;
  rig.position.set(0, 0, 0); rig.rotation.set(0, 0, 0); camera.position.set(0, 0, 0); camera.rotation.set(0, 0, 0);
  if (mode === 'scan') {
    initScan(); activeScene = scanScene; scanScene.add(rig); hud = makeScanHud(); scanScene.add(hud);
    renderer.setClearColor(0x000000, 0);
  } else {
    activeScene = houseScene; houseScene.add(rig); hud = makeWalkHud(); houseScene.add(hud); houseScene.add(tpMarker);
    const g = roomGroups.get(S.roomId) || [...roomGroups.values()][0]; if (g) rig.position.set(g.position.x, 0, g.position.z);
  }
  S.hudForce = 45; applyVisibility();
  session.addEventListener('end', onXREnd);
  await renderer.xr.setSession(session);
}
function onXREnd() {
  const mode = S.xrMode, saved = S.scan?.savedAny; S.xrMode = null;
  if (hud) { hud.parent?.remove(hud); disposeTree(hud); hud = null; }
  tpMarker.parent?.remove(tpMarker);
  if (mode === 'scan') endScan();
  activeScene = houseScene; houseScene.add(rig); rig.position.set(0, 0, 0); rig.rotation.set(0, 0, 0);
  renderer.setClearColor(0x000000, 1);
  onResize(); setView(S.view);
  if (saved) openHouse(S.house.id);
}
$('#btnWalkVR').onclick = () => startXR('walk');
$('#btnScan').onclick = () => $('#scanDlg').showModal();
$('#btnCancelScan').onclick = () => $('#scanDlg').close();
$('#btnStartScan').onclick = () => { $('#scanDlg').close(); startXR('scan'); };
$('#btnCam').onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
    const v = h('video', { muted: true, playsInline: true, autoplay: true, style: 'position:fixed;width:2px;height:2px;opacity:0;pointer-events:none' });
    v.srcObject = stream; document.body.append(v); await v.play();
    S.camStream = stream; S.camVideo = v; $('#btnCam').textContent = '✅ Camera ready'; $('#btnCam').disabled = true;
  } catch (e) { toast('Camera not available: ' + e.message + ' — Claude will use the 3D scan only.', 6000); }
};

// ---------- XR: scanning ----------
const SCAN_MAT = {
  global: new THREE.MeshBasicMaterial({ color: 0x2dd4bf, wireframe: true, transparent: true, opacity: 0.3 }),
  obj: new THREE.MeshBasicMaterial({ color: 0xfbbf24, wireframe: true, transparent: true, opacity: 0.9 }),
};
const PLANE_COLORS = { wall: 0x60a5fa, floor: 0x34d399, ceiling: 0xa78bfa, door: 0xf59e0b, window: 0x93c5fd };
const isStructural = (l) => !l || /global|floor|ceiling|door|window|invisible/i.test(l) || (/wall/i.test(l) && !/art/i.test(l));
const flatF32 = (v) => (v instanceof Float32Array ? new Float32Array(v) : Float32Array.from(Array.from(v).flatMap((p) => (p.length !== undefined ? Array.from(p) : [p.x, p.y, p.z]))));

function initScan() {
  S.scan = { meshes: new Map(), planes: new Map(), photos: [], tracing: false, trace: [], traceGroup: new THREE.Group(), tracedPlanes: [], status: '', savedAny: false, saving: false, t0: performance.now(), roomSetupTried: false };
  scanRoot.add(S.scan.traceGroup);
}
function endScan() {
  disposeTree(scanRoot); scanRoot.clear();
  if (S.camStream) { S.camStream.getTracks().forEach((t) => t.stop()); S.camVideo?.remove(); S.camStream = null; S.camVideo = null; $('#btnCam').textContent = '📷 Enable headset camera'; $('#btnCam').disabled = false; }
  S.scan = null;
}
function makeScanHud() {
  const sc = () => S.scan;
  return makeHud([
    { label: '📸 Photo', onClick: snapPhoto, enabled: () => !!S.camVideo },
    { label: '🧭 Room setup', onClick: roomSetup },
    { label: () => (sc()?.tracing ? '✔ Finish trace' : '✏️ Trace floor'), onClick: () => (sc().tracing ? finishTrace() : startTrace()) },
    { label: '↶ Undo point', onClick: undoTrace, enabled: () => !!sc()?.tracing && sc().trace.length > 0 },
    { label: '💾 Save room', onClick: saveScan, enabled: () => !sc()?.saving },
    { label: '✖ Exit', onClick: () => renderer.xr.getSession()?.end() },
  ]);
}
async function roomSetup() {
  const s = renderer.xr.getSession(); S.scan.roomSetupTried = true;
  if (!s?.initiateRoomCapture) { S.scan.status = '⚠ Room setup isn’t available here — run Space Setup in Quest settings, or use Trace floor.'; return; }
  try { await s.initiateRoomCapture(); S.scan.status = 'Room setup finished — data appears in a moment.'; } catch (e) { S.scan.status = '⚠ Room setup: ' + e.message; }
}
function scanUpdate(frame) {
  const sc = S.scan; if (!frame || !sc) return;
  const ref = renderer.xr.getReferenceSpace();
  const meshes = frame.detectedMeshes, planes = frame.detectedPlanes;
  if (meshes) {
    meshes.forEach((xm) => {
      let e = sc.meshes.get(xm);
      if (!e || e.t !== xm.lastChangedTime) {
        if (e) { scanRoot.remove(e.obj); e.obj.geometry.dispose(); }
        const verts = flatF32(xm.vertices), idx = new Uint32Array(xm.indices);
        const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(verts, 3)); geo.setIndex(new THREE.BufferAttribute(idx, 1));
        const label = (xm.semanticLabel || '').toLowerCase();
        const obj = new THREE.Mesh(geo, isStructural(label) ? SCAN_MAT.global : SCAN_MAT.obj); obj.matrixAutoUpdate = false; scanRoot.add(obj);
        e = { obj, t: xm.lastChangedTime, label, verts, idx, matrix: e?.matrix || null }; sc.meshes.set(xm, e);
      }
      const pose = frame.getPose(xm.meshSpace, ref);
      if (pose) { e.matrix = Array.from(pose.transform.matrix); e.obj.matrix.fromArray(e.matrix); e.obj.matrixWorldNeedsUpdate = true; }
    });
    for (const [xm, e] of sc.meshes) if (!meshes.has(xm)) { scanRoot.remove(e.obj); e.obj.geometry.dispose(); sc.meshes.delete(xm); }
  }
  if (planes) {
    planes.forEach((xp) => {
      let e = sc.planes.get(xp);
      if (!e || e.t !== xp.lastChangedTime) {
        if (e) { scanRoot.remove(e.obj); disposeTree(e.obj); }
        const pts = xp.polygon.map((p) => [p.x, p.y, p.z]);
        const label = (xp.semanticLabel || '').toLowerCase(); const kind = planeKind(label);
        const color = PLANE_COLORS[kind] ?? 0xfbbf24;
        const obj = new THREE.Group(); obj.matrixAutoUpdate = false;
        if (pts.length >= 3) {
          obj.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(...p))), new THREE.LineBasicMaterial({ color })));
          obj.add(new THREE.Mesh(polygonGeometry(pts), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false })));
        }
        scanRoot.add(obj);
        e = { obj, t: xp.lastChangedTime, label, pts, matrix: e?.matrix || null }; sc.planes.set(xp, e);
      }
      const pose = frame.getPose(xp.planeSpace, ref);
      if (pose) { e.matrix = Array.from(pose.transform.matrix); e.obj.matrix.fromArray(e.matrix); e.obj.matrixWorldNeedsUpdate = true; }
    });
    for (const [xp, e] of sc.planes) if (!planes.has(xp)) { scanRoot.remove(e.obj); disposeTree(e.obj); sc.planes.delete(xp); }
  }
  let tris = 0, objs = 0; for (const e of sc.meshes.values()) { if (isStructural(e.label)) tris += e.idx.length / 3; else objs++; }
  const kinds = [...sc.planes.values()].map((e) => planeKind(e.label));
  objs += kinds.filter((k) => !['wall', 'floor', 'ceiling', 'door', 'window'].includes(k)).length;
  const walls = kinds.filter((k) => k === 'wall').length + Math.max(0, sc.tracedPlanes.length - 1);
  const hasData = tris > 0 || sc.planes.size > 0 || sc.tracedPlanes.length > 0;
  const waited = performance.now() - sc.t0 > 4000;
  const lines = [
    `Mesh ${Math.round(tris).toLocaleString()} triangles · ${walls} walls · ${objs} furniture boxes · ${sc.photos.length}/8 photos`,
    sc.status || (sc.tracing ? `Tracing: point at each floor corner and pull the trigger / pinch (${sc.trace.length} points). Then Finish trace.`
      : hasData ? (S.camVideo ? 'Looks good! Look at furniture and press Photo (3–6), then Save room.' : 'Looks good! Press Save room. (Tip: enable the camera before scanning so Claude can see colors.)')
        : waited ? '⚠ No room data yet. Press Room setup to map this room, or Trace floor.' : 'Loading room data from the headset…'),
  ];
  paintInfo(hud, `Scanning · ${S.house?.name || ''}`, lines);
}
function snapPhoto() {
  const v = S.camVideo, sc = S.scan;
  if (!v || v.readyState < 2 || !v.videoWidth) { sc.status = '⚠ Camera is not sending images.'; return; }
  const s = Math.min(1, 1024 / Math.max(v.videoWidth, v.videoHeight));
  const c = document.createElement('canvas'); c.width = Math.round(v.videoWidth * s); c.height = Math.round(v.videoHeight * s);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  const p = camera.getWorldPosition(new THREE.Vector3()), q = camera.getWorldQuaternion(new THREE.Quaternion());
  sc.photos.push({ data: c.toDataURL('image/jpeg', 0.8).split(',')[1], pose: { p: p.toArray(), q: q.toArray() }, hfov: 72, aspect: c.width / c.height });
  if (sc.photos.length > 8) sc.photos.shift();
  sc.status = `📸 Photo ${sc.photos.length} saved. Take a few from different corners.`;
}
function startTrace() { const sc = S.scan; sc.tracing = true; sc.trace = []; sc.tracedPlanes = []; redrawTrace(); sc.status = ''; }
function addTracePoint(p) { S.scan.trace.push([p.x, 0, p.z]); redrawTrace(); }
function undoTrace() { S.scan.trace.pop(); redrawTrace(); }
function redrawTrace() {
  const sc = S.scan, g = sc.traceGroup; disposeTree(g); g.clear();
  for (const p of sc.trace) { const m = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8), new THREE.MeshBasicMaterial({ color: 0xf472b6 })); m.position.set(...p); g.add(m); }
  if (sc.trace.length > 1) g.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(sc.trace.map((p) => new THREE.Vector3(...p))), new THREE.LineBasicMaterial({ color: 0xf472b6 })));
}
function finishTrace() {
  const sc = S.scan; sc.tracing = false;
  if (sc.trace.length < 3) { sc.status = '⚠ Need at least 3 corners.'; return; }
  const H = 2.6, pts = sc.trace;
  sc.tracedPlanes = [{ label: 'floor', points: pts.map((p) => [...p]), normal: [0, 1, 0] }];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length]; const dx = b[0] - a[0], dz = b[2] - a[2], L = Math.hypot(dx, dz) || 1;
    sc.tracedPlanes.push({ label: 'wall', points: [[a[0], 0, a[2]], [b[0], 0, b[2]], [b[0], H, b[2]], [a[0], H, a[2]]], normal: [-dz / L, 0, dx / L] });
  }
  sc.status = `Floor traced (${pts.length} corners). Press Save room.`;
}

// Turn the live headset data into a clean room: world-space mesh + furniture boxes, squared to the walls, floor at y=0.
function yawFromMatrix(e) {
  const ax = [e[0], e[1], e[2]], az = [e[8], e[9], e[10]];
  return Math.abs(ax[1]) <= Math.abs(az[1]) ? Math.atan2(-ax[2], ax[0]) : Math.atan2(az[0], az[2]);
}
function orientedBox(pts, yaw, label) {
  const c = Math.cos(yaw), s = Math.sin(yaw); const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    const l = [p[0] * c - p[2] * s, p[1], p[0] * s + p[2] * c];
    for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], l[i]); mx[i] = Math.max(mx[i], l[i]); }
  }
  const lc = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
  return { label, center: [lc[0] * c + lc[2] * s, lc[1], -lc[0] * s + lc[2] * c], size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]], yaw };
}
function collectScan() {
  const sc = S.scan, M = new THREE.Matrix4(), v = new THREE.Vector3();
  const positions = [], indices = [], objects = [], planes = [];
  let base = 0;
  for (const e of sc.meshes.values()) {
    if (!e.matrix) continue; M.fromArray(e.matrix);
    const world = [];
    for (let i = 0; i < e.verts.length; i += 3) { v.set(e.verts[i], e.verts[i + 1], e.verts[i + 2]).applyMatrix4(M); world.push([v.x, v.y, v.z]); }
    if (isStructural(e.label)) { for (const p of world) positions.push(p[0], p[1], p[2]); for (const ix of e.idx) indices.push(ix + base); base += world.length; }
    else if (world.length) objects.push(orientedBox(world, yawFromMatrix(e.matrix), e.label));
  }
  const worldPlanes = [];
  for (const e of sc.planes.values()) {
    if (!e.matrix || e.pts.length < 3) continue; M.fromArray(e.matrix);
    worldPlanes.push({ e, pts: e.pts.map((p) => v.set(p[0], p[1], p[2]).applyMatrix4(M).toArray()), normal: [e.matrix[4], e.matrix[5], e.matrix[6]] });
  }
  const fl = worldPlanes.filter((w) => planeKind(w.e.label) === 'floor').flatMap((w) => w.pts.map((p) => p[1]));
  let floorLevel = fl.length ? fl.reduce((a, b) => a + b, 0) / fl.length : 0;
  if (Math.abs(floorLevel) > 0.3) floorLevel = 0;
  for (const { e, pts, normal } of worldPlanes) {
    planes.push({ label: e.label || 'other', points: pts, normal });
    if (!isStructural(e.label)) {
      const ctr = [0, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length);
      const near = objects.some((o) => Math.hypot(o.center[0] - ctr[0], o.center[2] - ctr[1]) < 0.6);
      if (near) continue;
      const solid = Math.abs(normal[1]) > 0.7 ? [...pts, ...pts.map((p) => [p[0], floorLevel, p[2]])] : [...pts, ...pts.map((p) => [p[0] - normal[0] * 0.05, p[1], p[2] - normal[2] * 0.05])];
      objects.push(orientedBox(solid, yawFromMatrix(e.matrix), e.label));
    }
  }
  planes.push(...sc.tracedPlanes);
  return { positions, indices, objects, planes, photos: sc.photos.slice() };
}
const QUEST_TYPE = { couch: 'sofa', sofa: 'sofa', chair: 'chair', table: 'table', desk: 'desk', bed: 'bed', screen: 'tv', monitor: 'tv', lamp: 'lamp', plant: 'plant', storage: 'cabinet', shelf: 'shelf', 'wall art': 'wall_art', 'wall_art': 'wall_art' };
function packRoom(raw, n) {
  // 1) square the room to the walls
  let sx = 0, sy = 0;
  for (const p of raw.planes) if (planeKind(p.label) === 'wall') { const a = 4 * Math.atan2(p.normal[0], p.normal[2]), w = area3(p.points) || 1; sx += Math.cos(a) * w; sy += Math.sin(a) * w; }
  if (!sx && !sy) for (const o of raw.objects) { const w = o.size[0] * o.size[2] || 0.1; sx += Math.cos(4 * o.yaw) * w; sy += Math.sin(4 * o.yaw) * w; }
  const theta = sx || sy ? Math.atan2(sy, sx) / 4 : 0;
  const floors = raw.planes.filter((p) => planeKind(p.label) === 'floor').sort((a, b) => polyArea(b.points) - polyArea(a.points));
  let floorY = floors[0] ? floors[0].points.reduce((s, p) => s + p[1], 0) / floors[0].points.length : 0;
  if (Math.abs(floorY) > 0.3) floorY = 0;
  const R = new THREE.Matrix4().makeRotationY(-theta), qR = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -theta), v = new THREE.Vector3();
  const rot = (p) => v.set(p[0], p[1] - floorY, p[2]).applyMatrix4(R).toArray();
  const planes = raw.planes.map((p) => ({ label: p.label, points: p.points.map(rot), normal: v.set(...p.normal).applyMatrix4(R).toArray() }));
  const objects = raw.objects.map((o) => ({ ...o, center: rot(o.center), yaw: o.yaw - theta }));
  const pos = new Float32Array(raw.positions);
  for (let i = 0; i < pos.length; i += 3) { const r = rot([pos[i], pos[i + 1], pos[i + 2]]); pos[i] = r[0]; pos[i + 1] = r[1]; pos[i + 2] = r[2]; }
  // 2) bounds → centre the room on its floor
  const mn = [Infinity, 0, Infinity], mx = [-Infinity, 0, -Infinity];
  const grow = (x, z) => { mn[0] = Math.min(mn[0], x); mx[0] = Math.max(mx[0], x); mn[2] = Math.min(mn[2], z); mx[2] = Math.max(mx[2], z); };
  const structural = planes.filter((p) => ['floor', 'wall'].includes(planeKind(p.label)));
  if (structural.length) structural.forEach((p) => p.points.forEach((q) => grow(q[0], q[2])));
  else if (pos.length) for (let i = 0; i < pos.length; i += 3) grow(pos[i], pos[i + 2]);
  else objects.forEach((o) => { // no walls or mesh: size the room around the furniture
    const c = Math.abs(Math.cos(o.yaw)), s = Math.abs(Math.sin(o.yaw)), hx = (c * o.size[0] + s * o.size[2]) / 2 + 0.3, hz = (s * o.size[0] + c * o.size[2]) / 2 + 0.3;
    grow(o.center[0] - hx, o.center[2] - hz); grow(o.center[0] + hx, o.center[2] + hz);
  });
  if (!Number.isFinite(mn[0])) { mn[0] = -2; mx[0] = 2; mn[2] = -2; mx[2] = 2; }
  const cx = (mn[0] + mx[0]) / 2, cz = (mn[2] + mx[2]) / 2;
  const ceil = planes.filter((p) => planeKind(p.label) === 'ceiling').flatMap((p) => p.points.map((q) => q[1]));
  let H = ceil.length ? ceil.reduce((a, b) => a + b, 0) / ceil.length : 0;
  if (!H && pos.length) { for (let i = 1; i < pos.length; i += 3) H = Math.max(H, pos[i]); }
  H = clamp(H || 2.6, 2, 6);
  const sh = (p) => [p[0] - cx, p[1], p[2] - cz];
  for (const p of planes) p.points = p.points.map(sh);
  for (const o of objects) o.center = sh(o.center);
  for (let i = 0; i < pos.length; i += 3) { pos[i] -= cx; pos[i + 2] -= cz; }
  const photos = raw.photos.map((ph) => {
    const p = sh(rot(ph.pose.p)); const q = qR.clone().multiply(new THREE.Quaternion(...ph.pose.q));
    return { ...ph, pose: { p, q: q.toArray() } };
  });
  return {
    name: `Room ${n}`,
    bounds: { min: [mn[0] - cx, 0, mn[2] - cz], max: [mx[0] - cx, H, mx[2] - cz] },
    planes,
    objects: objects.filter((o) => o.size[0] > 0.05 && o.size[2] > 0.02).map((o, i) => ({ id: 'q' + i, source: 'quest', label: o.label, type: QUEST_TYPE[o.label] || 'other', name: o.label ? o.label[0].toUpperCase() + o.label.slice(1) : 'Object', center: o.center, size: o.size, yaw: o.yaw })),
    mesh: pos.length ? { positions: toB64(pos), indices: toB64(new Uint32Array(raw.indices)) } : null,
    photos,
  };
}
async function saveScan() {
  const sc = S.scan; if (!sc || sc.saving) return;
  const raw = collectScan();
  if (!raw.positions.length && !raw.objects.length && !raw.planes.length) { sc.status = '⚠ Nothing scanned yet — press Room setup or Trace floor.'; return; }
  sc.saving = true; sc.status = 'Saving room…';
  try {
    const body = packRoom(raw, S.house.rooms.length + 1 + (sc.savedCount || 0));
    const room = await api('POST', `/api/houses/${S.house.id}/rooms`, body);
    sc.savedAny = true; sc.savedCount = (sc.savedCount || 0) + 1; sc.photos = [];
    sc.status = '🤖 Saved! Claude is detecting the furniture…';
    try {
      const det = await api('POST', `/api/houses/${S.house.id}/rooms/${room.id}/detect`, {}, true);
      sc.status = `✅ ${det.name}: ${det.objects.length} items — ${det.objects.slice(0, 4).map((o) => o.name).join(', ')}. Exit, or go to the next room and scan again.`;
    } catch (e) { sc.status = `✅ Room saved. ⚠ Claude: ${e.message}`; }
  } catch (e) { sc.status = '⚠ Save failed: ' + e.message; }
  sc.saving = false;
}

// ---------- XR: walking through the house ----------
function makeWalkHud() {
  return makeHud([
    { label: '➡ Next room', onClick: nextRoom, enabled: () => roomGroups.size > 0 },
    { label: () => `Labels: ${S.showLabels ? 'on' : 'off'}`, onClick: () => { S.showLabels = !S.showLabels; applyVisibility(); } },
    { label: () => `Scan mesh: ${S.showMesh ? 'on' : 'off'}`, onClick: () => { S.showMesh = !S.showMesh; applyVisibility(); } },
    { label: () => `Models: ${S.showModels ? 'on' : 'off'}`, onClick: () => { S.showModels = !S.showModels; applyVisibility(); } },
    { label: '▾ Hide menu', onClick: () => setMini(hud, true) },
    { label: '✖ Exit', onClick: () => renderer.xr.getSession()?.end() },
  ]);
}
function teleportTo(p) { const head = camera.getWorldPosition(_v1); rig.position.x += p.x - head.x; rig.position.z += p.z - head.z; S.hudForce = 2; }
function snapTurn(a) {
  const head = camera.getWorldPosition(new THREE.Vector3()); const off = rig.position.clone().sub(head);
  off.applyAxisAngle(new THREE.Vector3(0, 1, 0), a); rig.position.copy(head).add(off); rig.rotation.y += a; S.hudForce = 2;
}
function nextRoom() {
  const rooms = S.house.rooms; if (!rooms.length) return;
  const cur = roomAt(camera.getWorldPosition(new THREE.Vector3())); const i = cur ? rooms.indexOf(cur) : -1;
  const g = roomGroups.get(rooms[(i + 1) % rooms.length].id); if (g) teleportTo(g.position);
}
const _fw = new THREE.Vector3(), _rt = new THREE.Vector3();
function walkUpdate(dt) {
  const head = camera.getWorldPosition(new THREE.Vector3());
  for (const c of ctrls) {
    const src = c.userData.src, gp = src?.gamepad;
    if (gp) {
      const ax = gp.axes.length >= 4 ? gp.axes[2] : gp.axes[0] || 0, ay = gp.axes.length >= 4 ? gp.axes[3] : gp.axes[1] || 0;
      if (src.handedness === 'left' && (Math.abs(ax) > 0.15 || Math.abs(ay) > 0.15)) {
        camera.getWorldDirection(_fw); _fw.y = 0; _fw.normalize(); _rt.set(-_fw.z, 0, _fw.x);
        rig.position.addScaledVector(_fw, -ay * 1.8 * dt).addScaledVector(_rt, ax * 1.8 * dt);
      }
      if (src.handedness === 'right') {
        if (Math.abs(ax) > 0.7 && !c.userData.turned) { snapTurn(ax > 0 ? -Math.PI / 6 : Math.PI / 6); c.userData.turned = true; }
        if (Math.abs(ax) < 0.3) c.userData.turned = false;
      }
    }
    if (c.userData.aiming && !c.userData.consumed) {
      raycaster.setFromXRController(c);
      const hit = raycaster.intersectObjects(floorMeshes(), false)[0];
      let p = hit?.point || null;
      if (!p) { const q = new THREE.Vector3(); if (raycaster.ray.intersectPlane(groundPlane, q) && q.distanceTo(head) < 25) p = q; }
      c.userData.aimPoint = p; c.userData.aimDist = p ? raycaster.ray.origin.distanceTo(p) : 3;
    }
  }
  const aim = ctrls.find((c) => c.userData.aimPoint)?.userData.aimPoint;
  tpMarker.visible = !!aim; if (aim) tpMarker.position.set(aim.x, aim.y + 0.01, aim.z);
  const room = roomAt(head);
  paintInfo(hud, `${S.house.name}${room ? ' · ' + room.name : ''}`, [
    room?.ai?.summary || (room ? `${room.objects.length} items in this room` : 'Between rooms'),
    'Left stick: walk · Right stick: turn · Trigger or pinch: point & release to teleport',
  ]);
}

// ---------- main loop ----------
const clock = new THREE.Clock();
renderer.setAnimationLoop((t, frame) => {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (renderer.xr.isPresenting) {
    if (S.xrMode === 'scan') scanUpdate(frame);
    if (S.xrMode === 'walk') walkUpdate(dt);
    if (hud) { followHud(hud, S.hudForce > 0); if (S.hudForce > 0) S.hudForce--; updateRays(); }
  } else {
    if ($('#house').hidden) return;
    if (S.view === 'walk') desktopWalk(dt); else controls.update();
  }
  renderer.render(activeScene, camera);
});

// ---------- boot ----------
async function boot() {
  S.config = await fetch('/api/config').then((r) => r.json()).catch(() => ({}));
  if (navigator.xr) {
    const [ar, vr] = await Promise.all(['immersive-ar', 'immersive-vr'].map((m) => navigator.xr.isSessionSupported(m).catch(() => false)));
    S.support = { ar, vr };
  }
  $('#btnScan').disabled = !S.support.ar; $('#btnWalkVR').disabled = !S.support.vr;
  if (!S.support.ar) $('#btnScan').title = 'Open this site in the Meta Quest Browser to scan';
  if (!S.support.vr) $('#btnWalkVR').title = 'Open this site in the Meta Quest Browser to walk in VR';
  if (!S.token) return show('auth');
  const m = location.hash.match(/^#house\/([\w-]+)/);
  if (m) return openHouse(m[1]);
  loadHouses();
}
boot();
