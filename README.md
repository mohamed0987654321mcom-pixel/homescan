# MPARADISE HomeScan

Scan your house with a Meta Quest, let Claude detect the furniture, and walk through it in VR — from any device.

- **Scan**: open the site in the Meta Quest Browser → *Scan a room* (uses Quest 3/3S room mesh + Space Setup planes; *Trace floor* fallback).
- **Real photos**: while scanning, the headset camera takes photos by itself whenever you hold still; they're projected onto the scanned walls and furniture (with occlusion), so the room looks real instead of grey. An *Align photos* panel fine-tunes the camera offset.
- **Claude**: labels the furniture it detects (type, name, color, material) — shown as boxes + labels on your real furniture.
- **View anywhere**: dollhouse, floor plan (drag rooms together) and walk mode on desktop/phone; *Walk in VR* with controllers or hand tracking.

## Run
```
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
```

## Environment
| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key (server-side only) |
| `CLAUDE_MODEL` | Optional, default `claude-sonnet-5-5` |
| `DATA_DIR` | Where houses are stored (defaults to the Railway volume, else `./data`) |
| `SESSION_SECRET` | Optional; auto-generated and stored in the data dir |
