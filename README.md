# Canvas Tutor

A self-hosted school notes app with an AI tutor. Notes are organized **Year › Class › (notes or subfolders)** and come in two kinds:

- **Canvas notes**: a whiteboard you write on (Apple Pencil, Wacom, mouse). Claude sees the board, answers out loud and on screen, and draws on it: highlights, circles, arrows, typeset math, 2D/3D graphs, diagrams.
- **Markdown notes**: typed notes. Claude reads them when you ask about them.

Each folder can have **About** text (what the class is, how you like to learn) and **Tutor memory** (what Claude has learned). Both are set from the folder's menu and inherited down the tree: a class sees its year's About and memory plus its own.

Also included:

- Voice questions and spoken answers, with optional server-side Whisper and Kokoro.
- Handwriting neatening and letter matching that learns from samples of your writing.
- Apple Pencil mode: fingers pan, zoom and select, and resting palms are ignored.
- Live sync across open devices, a Ctrl/⌘-K quick switcher, back/forward and trash.

It's built for one person: there's a single login password and one set of notes.

## How it works

- **Web app:** React + [tldraw](https://tldraw.dev) for canvases, [Milkdown](https://milkdown.dev) for markdown.
- **Server:** Node. Notes are plain files under `data/notes/` (`.md`, and `.tldr` for canvases), with `data/notes-index.json` giving each note a stable id, conversation and Claude session.
- **Tutor:** Claude runs through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) on your Claude subscription. Its tools are an in-process MCP server (`server/tools.ts`). It checks its math with [Qalculate](https://qalculate.github.io) and SymPy.

## Run locally

Needs Node 22+ and [Claude Code](https://claude.com/claude-code) signed in on the same machine.

```bash
npm install
```

Create `.env`:

```
TUTOR_PASSWORD=pick-a-password
```

```bash
npm run dev
```

Open http://localhost:8795 and log in with that password.

## Self-host on a server

`deploy/deploy.sh` builds on your computer, uploads to `/opt/canvas-tutor` on a Linux server over SSH, and restarts a `canvas-tutor` systemd service. The service runs as a `tutor` user and keeps data in `/var/lib/canvas-tutor/data`. Put a reverse proxy with HTTPS (e.g. nginx + Let's Encrypt) in front of port 8795.

One-time server setup (as root, with Node 22+ installed):

```bash
useradd --system --create-home tutor
mkdir -p /opt/canvas-tutor /var/lib/canvas-tutor && chown tutor:tutor /opt/canvas-tutor /var/lib/canvas-tutor
```

Then add your server to `.env` on your computer and deploy:

```
DEPLOY_HOST=root@your-server
```

```bash
bash deploy/deploy.sh
```

(`bash deploy/deploy.sh user@host` works too.)

The server layout is set in the `deploy/` files. To use a different install folder, data folder, user or port, change them in each:

- `deploy/deploy.sh`: `/opt/canvas-tutor`, the `tutor` user, the `canvas-tutor` service name.
- `deploy/canvas-tutor.service`: the same, plus `PORT` and the `/var/lib/canvas-tutor` paths for data and the optional extras.
- `deploy/set-secrets.sh`: `/opt/canvas-tutor/.env` and the service name.

Set the login password and Claude token on the server (input is hidden). Get the token by running `claude setup-token` on your own computer.

```bash
ssh -t root@your-server bash /opt/canvas-tutor/deploy/set-secrets.sh
```

Each answered question logs a `[turn]` line (`journalctl -u canvas-tutor | grep turn`) with total time, time to first text, model steps and tool calls.

### Optional extras

The math checkers:

```bash
apt-get install -y qalc
sudo -u tutor -H bash -c 'cd /var/lib/canvas-tutor && uv venv --python /usr/bin/python3 venv && uv pip install --python venv/bin/python sympy'
```

The Kokoro voice (without it, the app uses the device's built-in voices). Model files come from the [kokoro-onnx releases](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0):

```bash
sudo -u tutor -H bash -c 'cd /var/lib/canvas-tutor && uv venv --python 3.12 tts-venv && uv pip install --python tts-venv/bin/python kokoro-onnx soundfile && mkdir -p kokoro && cd kokoro && for f in kokoro-v1.0.onnx voices-v1.0.bin; do curl -fLO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/$f; done'
```

Whisper speech recognition (without it, the app uses the browser's). It shares the Kokoro venv and needs ffmpeg:

```bash
apt-get install -y ffmpeg
sudo -u tutor -H bash -c 'cd /var/lib/canvas-tutor && uv pip install --python tts-venv/bin/python faster-whisper && mkdir -p whisper'
```

The paths above match the environment variables in `deploy/canvas-tutor.service`.

### tldraw license

Production builds need a tldraw license key in `.env` as `VITE_TLDRAW_LICENSE_KEY` (it's compiled into the web app). A free [hobby license](https://tldraw.dev/get-a-license/hobby) works for personal use. Each key is for one domain, so get one for yours. The app shows a reminder 30 days before the key expires.

## Data

Everything lives in the data folder (`data/` locally, `/var/lib/canvas-tutor/data` on a server): `notes/` (the tree, with `.folder.json` files holding each folder's About/memory and `.trash/` for deleted items), `notes-index.json`, uploaded images in `assets/`, and your handwriting samples. Back up that folder to back up your notes.

## Layout

| Path | What |
|---|---|
| `server/index.ts` | HTTP server: login, notes API, canvas sync, `/api/ask` (streams events) |
| `server/notes.ts` | The notes tree on disk: create/rename/move/trash, About/memory, search |
| `server/board.ts` | Live sync for open canvas notes |
| `server/tutor.ts` | One long-lived Claude session per note |
| `server/tools.ts` | Drawing tools Claude can call |
| `server/svg.ts` | LaTeX (MathJax), graph, and line rendering to SVG |
| `server/prompt.ts` | Tutor system prompt (scope rules: next step vs hint vs example) |
| `src/Shell.tsx`, `src/NotesUI.tsx` | Sidebar, quick switcher, menus, dialogs |
| `src/Tutor.tsx` | Main UI: canvas, mic, reply card, status pill, settings |
| `src/canvas.ts` | Board snapshot for Claude + applying Claude's drawing ops |
| `src/neaten.ts`, `src/recognize.ts` | Handwriting neatening and letter matching |
| `src/pencilMode.ts` | Apple Pencil mode |
| `src/voice.ts` | Speech recognition and speech output |
