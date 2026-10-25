# Papervoice

Turn any PDF into something you can hear. Upload a document, pick a voice and speed, then stream or download the generated MP3. Free, no account needed.

Text is extracted with `pypdf` (with automatic Tesseract OCR for scanned pages), cleaned of repeated headers/footers, and synthesized with Microsoft Edge TTS. The browser gets live progress and an ETA while the job runs.

## Features

- Drag-and-drop PDF upload (25 MB cap), ten Edge TTS voices, adjustable speed
- Async job processing with live page/chunk progress and a real-time ETA countdown
- Analog countdown clock whose hands track the remaining time
- Automatic OCR fallback for image-only pages, with graceful degradation if OCR fails
- Repeated-header/footer and page-number cleanup before narration
- Parallel TTS synthesis (four chunks at once by default)
- Audio playback plus MP3 download; files auto-expire after two hours

## Stack

| Layer | Technology |
|---|---|
| Backend | Flask, SQLite job store, `edge-tts`, `pypdf`, `pytesseract` / `pdf2image` |
| Frontend (active) | React 19, Vite, framer-motion, Three.js / OGL |
| Frontend (legacy) | Vanilla HTML/CSS/JS in `templates/index.html`, served by Flask |
| Deployment | Docker on Render (gunicorn, single worker) |

## Project structure

```
papervoice_v2/
├── app.py                     # Flask API, extraction/OCR, parallel TTS, job store
├── templates/index.html       # Legacy UI served by Flask at /
├── frontend/                  # React + Vite UI (active development)
│   ├── src/App.jsx            # Upload form, polling, ETA clock, results
│   ├── src/App.css            # Theme, typography, clock, controls
│   ├── src/AnimatedDropdown.jsx
│   ├── src/VoiceAuroraWave.jsx
│   └── src/RippleDistortion.jsx
├── design/                    # Standalone HTML prototypes (clock, orb, mockup)
├── requirements.txt
├── Dockerfile                 # python:3.11-slim + tesseract + poppler
├── Procfile
├── README.md
├── ARCHITECTURE.md            # Component, request, and pipeline details
└── ISSUES.md                  # Known issues, verification notes, backlog
```

## Getting started

### Prerequisites

- Python 3.11+
- Node.js 20.19+ (required by Vite 8)
- Tesseract OCR and Poppler — only needed for scanned PDFs. See `ISSUES.md` for platform notes.

### Backend

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1        # Windows PowerShell
# source .venv/bin/activate       # macOS / Linux
pip install -r requirements.txt
python app.py
```

The API and the legacy UI are served at `http://127.0.0.1:5000`.

### React frontend

Start the backend first, then:

```powershell
cd frontend
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. Vite proxies `/convert`, `/progress`, and `/audio` to `http://127.0.0.1:5000`, so no CORS setup is needed.

```powershell
npm run lint      # oxlint
npm run build     # production bundle in frontend/dist
```

> The React bundle is not yet served by Flask. The deployed app still renders `templates/index.html`; running `npm run build` produces `frontend/dist` but the backend does not serve it.

### Windows note

Use `127.0.0.1` rather than `localhost` if the browser cannot reach the Flask server, and allow Python through Windows Firewall. This is a common local-dev gotcha, not an application bug.

## Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `PORT` | `5000` | Flask / gunicorn listen port |
| `TTS_CONCURRENCY` | `4` | Number of TTS chunks synthesized in parallel |
| `TTS_CHARS_PER_SECOND` | `250` | Per-stream synthesis rate used to seed the ETA |
| `JOBS_DB_PATH` | `/tmp/jobs.db` | SQLite job-store location |

## Deployment

`Dockerfile` installs Tesseract and Poppler, then runs gunicorn with `--workers 1 --timeout 600`. Render auto-detects the Dockerfile. The live deployment is documented in `ISSUES.md`.

Because `/tmp` is ephemeral on Render, audio and job rows do not survive a redeploy. The React frontend is not part of the current deployment path — see the note above.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — components, request lifecycle, extraction and TTS pipelines, job model
- [ISSUES.md](ISSUES.md) — known issues, deployment notes, verification results, backlog
- [papervoice_project_handoff.md](papervoice_project_handoff.md) — historical handoff notes
