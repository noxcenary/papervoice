# 📖 Papervoice — Project Handoff

**What it is:** A web app where anyone can upload a PDF, pick a voice, and get it read aloud — either streamed in-browser or downloaded as an mp3. Free stack, no accounts needed.

This doc is meant to be pasted into a new chat (or given to an agent in Antigravity IDE) to pick up exactly where things left off.

---

## Current Status

Built and sandbox-tested. **Not yet deployed to Railway** (deployment is the next step). The original v1 (synchronous, no OCR) was tested locally on Windows and confirmed working end-to-end including real audio generation. The v2 rewrite (async jobs, progress/ETA, OCR fallback) has been tested in the Claude sandbox for everything except the actual Microsoft TTS network call (sandbox network restriction, not a real bug — that exact code path already worked in v1).

---

## Architecture

```
Browser (upload PDF + pick voice)
   ↓ POST /convert  →  returns job_id immediately
Flask app (app.py)
   ↓ background thread per job
1. pypdf extracts text per page
2. If a page has almost no text → Tesseract OCR fallback (rasterize page, OCR it)
3. Groq-free approach not used here — text goes straight to TTS (no AI summarization step, unlike the email bot project)
4. Microsoft Edge TTS converts text to speech, chunked for long documents
   ↓
Browser polls GET /progress/<job_id> every 1.2s
   → shows "Page X of Y", then "Part X of Y", plus live ETA
   ↓ on completion
GET /audio/<job_id> streams the mp3 for playback + download
```

---

## Tech Stack (100% free)

| Layer | Tool |
|---|---|
| Web framework | Flask + gunicorn |
| PDF text extraction | pypdf |
| OCR fallback | pytesseract + pdf2image (needs system binaries: tesseract-ocr, poppler-utils) |
| Text-to-speech | Microsoft Edge TTS (edge-tts library) — same free unlimited TTS used in the email voice bot project |
| Frontend | Vanilla HTML/CSS/JS, no framework — polling-based progress bar |
| Intended host | Railway.app (not yet deployed) |

---

## Files in the project

```
papervoice/
├── app.py              ← Flask backend, async job system, OCR fallback
├── templates/
│   └── index.html      ← Upload form + voice picker + live progress UI
├── requirements.txt     ← flask, edge-tts, pypdf, gunicorn, pytesseract, pdf2image, Pillow
├── Procfile             ← gunicorn start command (1 worker — see known issues)
├── Dockerfile            ← alternate deploy path if Railway's default buildpack can't install tesseract/poppler
├── .gitignore
└── ISSUES.md            ← full known-issues + handoff notes (see below, copy this in full)
```

---

## Design

Visual identity: "Papervoice" — dark ink background (#14181F), warm paper-cream card (#F6F1E4) for the upload widget, amber accent (#E8A33D). Serif display font (Fraunces) for the headline, Inter for body. Signature element: a small idle waveform animation next to the headline. Deliberately avoided the generic cream+terracotta / dark+neon AI-website look.

---

## ⚠️ Known Issues — READ BEFORE CONTINUING

Full details in `ISSUES.md` inside the project zip. Summary of what matters most:

1. **In-memory job storage (`JOBS` dict in app.py)** — this is the biggest real risk. It doesn't persist across server restarts and won't work correctly if gunicorn runs more than 1 worker (each worker has its own copy of the dict, so a progress-poll request can hit a different worker and 404). Procfile is currently set to `--workers 1` as a stopgap. Proper fix: move job state to Redis or SQLite.

2. **OCR needs system binaries Railway may not install by default** — `tesseract-ocr` and `poppler-utils` are NOT Python packages; they're OS-level programs. Railway's default Python buildpack (Railpack) only installs pip packages. Included a `Dockerfile` as a safer alternative deploy path, but **this has not been tested on Railway yet** — needs verification that Railway auto-detects and builds the Dockerfile correctly, and that the `apt-get install` step succeeds in their build environment.

3. **OCR tested only on a synthetic clean image** — real scanned documents (skewed, noisy, low-res) may perform worse. Needs testing with an actual scanned PDF.

4. **No cleanup job** — converted PDFs and audio files pile up in `/tmp/pdf_uploads` and `/tmp/pdf_audio` with no expiry. Fine short-term, will fill disk eventually.

5. **Encrypted/password-protected PDFs** — not handled, will likely throw an unfriendly error.

6. **Concurrency** — with `--workers 1`, only one conversion can run at a time across ALL users. Fine for personal/low-traffic use; not fine if this gets real traffic.

---

## Feature Requests (delivered vs still open)

- [x] Show time remaining before conversion finishes (ETA, calculated live from elapsed time per chunk)
- [x] Show how many pages have been processed during reading/OCR phase
- [x] Detect if a PDF needs OCR and auto-convert it there rather than failing
- [ ] Cleanup routine for old temp files
- [ ] Handle encrypted PDFs gracefully
- [ ] Rate limiting / abuse prevention (this will be public-facing once deployed)
- [ ] Real job queue (Redis/Celery) instead of in-memory dict + threads, if traffic grows

---

## Immediate Next Steps

1. Migrate this project into Antigravity IDE
2. Hand the agent `ISSUES.md` first so it has full context before touching code
3. Test OCR against a real scanned PDF (not just the synthetic one used in the Claude sandbox)
4. Deploy to Railway — decide whether to use the default Python buildpack (simpler, but OCR likely won't work without extra config) or the included `Dockerfile` (more reliable for system dependencies, but unverified on Railway specifically)
5. Once deployed, generate a public domain via Railway's Networking settings and it's shareable

---

## Related Project (for context, not part of this one)

This reuses the same free Edge TTS approach as an earlier project — an **Email Voice Summary Bot** that reads Gmail, summarizes with Groq AI, and sends a voice note to Telegram every 6 hours, hosted on Railway. That project is fully deployed and working. Papervoice is a separate, standalone app that doesn't share any code or infrastructure with it, just the TTS technique.
