# Papervoice — Architecture & Flow

Papervoice converts a PDF into spoken audio. A user uploads a PDF, chooses a voice and speed, then streams or downloads an MP3 generated with Microsoft Edge TTS. Scanned pages fall back to Tesseract OCR automatically.

This document describes the current implementation in `app.py` and the React frontend in `frontend/`. The legacy vanilla UI (`templates/index.html`) is still served by Flask and is what the Render deployment uses today. For known issues and verification notes, see `ISSUES.md`.

---

## 1. High-Level Overview

```
React UI (Vite, :5173, dev) ──┐
Legacy UI (Flask /, prod)  ───┤
                              ▼
POST /convert (multipart: pdf, voice, speed)
  │  save upload → insert job row → spawn daemon thread → return job_id
  ▼
Background thread (run_conversion_job)
  │
  ├─ 1. Extract text per page with pypdf
  │      └─ page is nearly empty? → OCR fallback (pdf2image + Tesseract)
  ├─ 2. Strip running headers/footers and standalone page numbers
  ├─ 3. Clean text → split into ~8,000-char chunks
  ├─ 4. Synthesize chunks in parallel with Edge TTS (4 at a time by default)
  ├─ 5. Concatenate parts in order into one MP3
  └─ 6. Mark job done, set audio_url
  ▼
Browser polls GET /progress/<job_id> every 1.2 s
  │  renders page progress, chunk progress, ETA, and countdown clock
  ▼
GET /audio/<job_id> → streams the MP3 for playback and download
```

`/convert` returns immediately; extraction and synthesis run in a background thread. Progress is persisted in SQLite, so polling survives worker restarts within the same container.

---

## 2. Components

### Backend — `app.py`

| Area | Responsibility | Key symbols |
|---|---|---|
| App setup | Flask app, 25 MB upload cap, temp directories | `app`, `UPLOAD_DIR`, `AUDIO_DIR` |
| Voice catalog | Allowed Edge TTS voices and descriptions | `VOICES` |
| Job store | SQLite-backed job state and progress | `_get_conn`, `_init_jobs_db`, `update_job`, `get_job` |
| Cleanup | Daemon thread deleting audio older than 2 h | `_cleanup_old_audio`, `AUDIO_TTL_SECONDS` |
| Extraction | Per-page text extraction with OCR fallback | `extract_page_text`, `ocr_page`, `extract_text_with_progress` |
| Text cleanup | Boilerplate/page-number removal, whitespace normalization, chunking | `strip_repeated_boilerplate`, `strip_page_numbers`, `clean_text`, `chunk_text` |
| TTS | Parallel Edge TTS synthesis with live progress/ETA | `synthesize_with_progress` |
| Job runner | Orchestrates extraction → TTS → completion | `run_conversion_job` |
| Routes | HTTP endpoints | `index`, `convert`, `progress`, `get_audio` |

### Frontend — React (`frontend/`)

Active UI. React 19 + Vite, with `framer-motion` for dropdowns and Three.js / OGL for the result visualizer.

| File | Responsibility |
|---|---|
| `src/App.jsx` | Upload form, polling, phase→progress mapping, ETA formatting, analog countdown clock, result player |
| `src/AnimatedDropdown.jsx` | Shared animated select with keyboard navigation and click-away |
| `src/VoiceDropdown.jsx`, `src/SpeedDropdown.jsx` | Option definitions for the two pickers |
| `src/VoiceAuroraWave.jsx` | Audio-reactive orb visualizer shown after conversion |
| `src/RippleDistortion.jsx` | Background ripple/plasma effect |
| `src/App.css` | Theme, typography scale, drop zone, buttons, clock, status/result styles |

- Vite dev server runs on port 5173 and proxies `/convert`, `/progress`, and `/audio` to `http://127.0.0.1:5000` (`vite.config.js`).
- Production bundle (`npm run build`) lands in `frontend/dist`, but Flask does not serve it.
- Typography: Bodoni Moda headline, Instrument Sans subtitle, sizes locked to a 1.618 ratio via `--title-size` / `--subtitle-size`. The mobile breakpoint uses a 32px headline.

### Frontend — legacy (`templates/index.html`)

Single-page vanilla HTML/CSS/JS rendered by Flask at `/`. It implements the same flow (server-rendered voice list, polling, clock, orb) and remains the deployed UI. New UI work happens in `frontend/`.

---

## 3. Request Lifecycle

### 3.1 Upload and job creation — `POST /convert`

Implemented by `convert` in `app.py`.

1. Validate that a file was provided, has a `.pdf` extension, and that the selected voice is in `VOICES`.
2. Parse `speed` as an integer, clamp to `[-50, 50]`, and convert to an Edge TTS rate string such as `+20%` or `-20%`.
3. Generate a UUID `job_id`.
4. Save the upload to `/tmp/pdf_uploads/<job_id>.pdf`; audio is written to `/tmp/pdf_audio/<job_id>.mp3`.
5. Insert a job row with `status='processing'`, `phase='starting'`.
6. Start a daemon thread running `run_conversion_job`.
7. Return `{"job_id": ...}` immediately.

The uploaded PDF is deleted in the job's `finally` block after processing, success or failure.

### 3.2 Background processing — `run_conversion_job`

1. `extract_text_with_progress` reads the PDF and produces cleaned page text.
2. `clean_text` normalizes whitespace and drops short numeric lines.
3. Word count is recorded.
4. `asyncio.run(synthesize_with_progress(...))` generates the MP3.
5. On success: `status='done'`, `phase='done'`, `audio_url='/audio/<job_id>'`, `eta_seconds=0`.
6. On any exception: `status='error'` with the exception message.
7. Finally: delete the uploaded PDF.

### 3.3 Progress polling — `GET /progress/<job_id>`

Returns the full job row as JSON: `status`, `phase`, page/chunk counters, `eta_seconds`, `ocr_used`, `ocr_error`, `word_count`, `audio_url`, and `error`. Returns 404 for unknown jobs.

The React UI polls every 1200 ms and maps phases to progress:

| Phase | Progress range | UI text |
|---|---|---|
| `starting` | 0% | "Starting…" |
| `extracting` | 0–40% | "Reading page X of Y…" |
| `ocr` | 0–40% | "Running OCR on page X… (scanned page detected)" |
| `converting` | 40–100% | "Converting to audio… part X of Y" |
| `done` | 100% | Shows audio player and download link |

ETA handling:

- During extraction, `eta_seconds` is a per-page linear extrapolation of remaining pages. The React UI hides the value until three pages have been read to avoid noisy early estimates.
- During conversion, the ETA is seeded from `total_chars / (TTS_CHARS_PER_SECOND × TTS_CONCURRENCY)` and updated every second by a ticker task, even while long chunks are still synthesizing.
- The React countdown clock converts `remaining / total` into hand angles: the minute hand sweeps 360° over the phase's countdown, the hour hand runs at 1/12 speed. `etaTotal` is the peak ETA observed in the current phase and resets when the pipeline moves from extraction to conversion. Before an ETA exists, the clock falls back to pipeline progress.

### 3.4 Audio delivery — `GET /audio/<job_id>`

Streams `/tmp/pdf_audio/<job_id>.mp3` as `audio/mpeg` inline, so the same URL can be played and downloaded.

---

## 4. Text Extraction Pipeline

Implemented in `extract_text_with_progress`.

```
for each page:
    text = pypdf.extract_text(page)
    if word_count(text) < 20:
        try OCR(page)
        keep OCR text only if it has more words than pypdf text
    append page text
    update pages_done / eta_seconds
then:
    strip_repeated_boilerplate(pages_text, threshold=0.6)
    strip_page_numbers(pages_text)
    join pages with blank lines
```

Details:

- **Encrypted PDFs** are rejected before iteration via `reader.is_encrypted`, raising a friendly `ValueError`.
- **OCR trigger threshold**: `MIN_WORDS_PER_PAGE_BEFORE_OCR = 20`. Pages with fewer words are treated as likely scanned/image-only.
- **OCR implementation** (`ocr_page`): `pdf2image.convert_from_path` rasterizes one page at 200 DPI, then `pytesseract.image_to_string` extracts text. Both packages are imported lazily; if missing, an informative `RuntimeError` is raised. OCR failures are recorded in `ocr_error` but do not fail the job — existing text is kept.
- **Boilerplate removal** (`strip_repeated_boilerplate`): lines are normalized by stripping trailing numbers/dashes, counted once per page, and any line appearing on at least 60% of pages (minimum 2) is removed. This targets headers, footers, and author/course-code lines.
- **Page numbers** (`strip_page_numbers`): removes standalone numeric lines like `42` or `- 7 -`, plus worded footers such as `Page 3`, `Page 3 of 28`, and `3 of 28`.
- If no text is extracted even after OCR, a `ValueError` is raised with a user-facing message.

Both cleanup passes run after the per-page loop because the 60% repetition threshold needs the full page list, and both paths (native text and OCR) must be covered.

---

## 5. Text-to-Speech Pipeline

Implemented in `synthesize_with_progress`.

1. `chunk_text` splits the text on spaces into chunks of at most `MAX_CHARS_PER_CHUNK = 8000` characters.
2. Job phase becomes `converting`; `chunks_total` is recorded.
3. Concurrency is `min(TTS_CONCURRENCY, total_chunks)`; the default is 4.
4. The ETA is seeded from `total_chars / (TTS_CHARS_PER_SECOND × concurrency)` (`TTS_CHARS_PER_SECOND` defaults to 250) and a background task updates `eta_seconds` every second.
5. Each chunk runs through a semaphore and `edge_tts.Communicate(chunk, voice, rate=rate).save(...)`. Up to four run concurrently; `chunks_done` increments as each completes.
6. `asyncio.gather` preserves chunk order. If there is one part it is renamed to `<job_id>.mp3`; otherwise parts are concatenated bytewise into the final MP3 and deleted.
7. The ETA task is cancelled in `finally`.

Environment knobs:

| Variable | Default | Effect |
|---|---|---|
| `TTS_CONCURRENCY` | `4` | Number of chunks synthesized at once |
| `TTS_CHARS_PER_SECOND` | `250` | Per-stream character rate used to seed the ETA |

Notes:

- Parallelism is the main speed lever. Measured on a 40-page text PDF, wall time dropped from 93–151 s sequentially to roughly 10 s on a fast network; Microsoft-side throttling can push the same job to 26–36 s.
- Byte-level concatenation of MP3 frames works in practice and avoids an ffmpeg dependency. There is no transcoding, normalization, or gap handling between chunks.
- Voice selection is restricted to the ten Microsoft Edge neural voices in `VOICES`. Speed is translated to an Edge TTS rate percentage.

---

## 6. Job State Model

Jobs are stored in SQLite at `JOBS_DB_PATH` (default `/tmp/jobs.db`), initialized on import (`_init_jobs_db`).

### `jobs` table

| Column | Meaning |
|---|---|
| `job_id` | UUID primary key |
| `status` | `processing` \| `done` \| `error` |
| `phase` | `starting` \| `extracting` \| `ocr` \| `converting` \| `done` |
| `pages_total`, `pages_done` | Extraction/OCR progress |
| `chunks_total`, `chunks_done` | TTS progress |
| `eta_seconds` | Wall-clock estimate for the current phase |
| `ocr_used` | Whether OCR improved any page (stored as 0/1) |
| `ocr_page_number` | Page currently being OCR'd, when applicable |
| `ocr_error` | Last OCR error message, if any |
| `word_count` | Words sent to TTS |
| `audio_url` | `/audio/<job_id>` once complete |
| `error` | Failure message when `status='error'` |

`update_job` builds a partial `UPDATE` from keyword arguments; `get_job` returns the row as a dict with `ocr_used` coerced to bool.

### Persistence characteristics

- SQLite survives process restarts on the same container, unlike the older in-memory dict.
- On Render's free tier, `/tmp` is ephemeral: a redeploy wipes both the database and audio files.
- Both `Procfile` and `Dockerfile` pin `--workers 1`, so a single process handles all requests and background jobs.
- Job rows are never deleted; only audio files expire.

---

## 7. File & Directory Layout

```
papervoice_v2/
├── app.py                      # Flask app, jobs, extraction, OCR, parallel TTS, routes
├── templates/
│   └── index.html              # Legacy UI served by Flask at /
├── frontend/                   # React + Vite UI (active development)
│   ├── index.html
│   ├── vite.config.js          # Dev server proxy to Flask on :5000
│   ├── package.json
│   └── src/
│       ├── main.jsx
│       ├── App.jsx             # Upload, polling, ETA clock, results
│       ├── App.css             # Theme, typography, controls, clock
│       ├── AnimatedDropdown.jsx
│       ├── VoiceDropdown.jsx
│       ├── SpeedDropdown.jsx
│       ├── VoiceAuroraWave.jsx
│       └── RippleDistortion.jsx
├── design/                     # Standalone HTML prototypes (clock, orb, mockup)
├── requirements.txt
├── Procfile                    # gunicorn start (1 worker, 600 s timeout)
├── Dockerfile                  # python:3.11-slim + tesseract-ocr + poppler-utils
├── README.md                   # Setup and run instructions
├── ARCHITECTURE.md             # This file
├── ISSUES.md                   # Known issues and verification notes
├── papervoice_project_handoff.md
└── .agents/skills/             # Local agent skill definitions
```

Runtime directories (created at import, not in the repo):

```
/tmp/pdf_uploads/<job_id>.pdf   # deleted after each job finishes
/tmp/pdf_audio/<job_id>.mp3     # kept for 2 h, then cleaned
/tmp/jobs.db                    # SQLite job store
```

---

## 8. Concurrency & Background Work

- Each upload spawns one Python `threading.Thread` (`daemon=True`) to run the job.
- TTS is async (`edge_tts`), executed inside that thread via `asyncio.run`. Within a job, up to `TTS_CONCURRENCY` chunks are in flight concurrently.
- The cleanup loop is a daemon thread that wakes every 10 minutes and deletes audio older than 2 hours.
- With one gunicorn worker, request handling and background threads share a single process. Long jobs do not block `/progress` or `/audio` because those are quick I/O-bound handlers, but CPU-heavy OCR competes with request handling.
- There is no shared task queue, retry policy, rate limiting, or fairness control. A real queue (RQ/Celery + Redis) would be required for higher traffic.

---

## 9. Deployment

- **Docker** (`Dockerfile`): `python:3.11-slim`, installs `tesseract-ocr` and `poppler-utils` via apt (required for OCR), installs pip dependencies, runs gunicorn on `0.0.0.0:5000` with `--timeout 600 --workers 1`.
- **Procfile** provides the equivalent gunicorn command for platforms that use it.
- **Render** auto-detects the Dockerfile. The live deployment is documented in `ISSUES.md`.
- The 600-second gunicorn timeout accommodates long OCR/TTS runs.
- Ephemeral `/tmp` means jobs and audio do not survive redeploys.
- **Deployment gap:** the deployed app serves the legacy `templates/index.html`. The React build in `frontend/dist` is not served by Flask yet.

---

## 10. Security, Limits & Operational Notes

- Upload size capped at 25 MB via `MAX_CONTENT_LENGTH`.
- Only `.pdf` filenames and known voice IDs are accepted; speed is clamped.
- No authentication, user accounts, CSRF protection, or rate limiting.
- Uploaded PDFs are deleted after processing; audio is deleted after 2 hours.
- OCR binaries are required in the runtime image. Without them, OCR failures are recorded per page and the job continues with whatever text pypdf produced.
- Error messages surface in the UI; the frontend also handles non-JSON responses (proxy/gateway errors) defensively.

---

## 11. Known Architectural Limitations

These are documented in more detail in `ISSUES.md`:

- OCR is slow on real scanned documents (measured around 43 s/page) and accuracy on noisy scans is not fully validated.
- ETA is a calibrated wall-clock estimate, not measured synthesis progress. It is conservative and can finish early on a fast network or lag under Microsoft-side throttling.
- Parallel TTS performance varies with Microsoft's service; concurrency above four has not shown consistent gains in testing.
- Audio concatenation is bytewise MP3 joining, not a proper audio mix.
- Job rows accumulate in SQLite indefinitely; only audio files are cleaned up.
- A redeploy or container restart during a job loses the job's in-flight state and audio.
- Single worker serializes jobs; background threads are not durable or distributed.
- Two frontends exist, and only the legacy one is deployed.
- Repeated-line removal can strip legitimately repeated short-document headings (60% threshold edge case).
