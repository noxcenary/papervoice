# Papervoice — Known Issues & Handoff Notes

Last updated: 2026-10-26. See `README.md` for setup and `ARCHITECTURE.md` for the
current request/pipeline design.

Written for whoever (human or agent) picks this project up next in Antigravity IDE.
This documents everything currently broken, untested, or intentionally incomplete.

---

## 🔴 Confirmed Bugs

### 1. `/convert` blocks the whole request — no progress feedback
**Status:** Fixed in this version (see `app.py` v2 — job-based async flow with polling).
The original version ran extraction + TTS synchronously inside the POST handler, so
the browser just sat on a spinner with no way to know if it was stuck or working.
Now `/convert` returns a `job_id` immediately and the frontend polls `/progress/<job_id>`.

### 2. No handling for scanned/image-only PDFs
**Status:** Fixed and verified working on a synthetic test case (image-only
single page PDF) in the Claude sandbox — confirmed OCR correctly triggers
(`ocr_used: True`) and extracts readable text via Tesseract. Normal text-based
PDFs correctly skip OCR (`ocr_used: False`, no speed penalty).
Since then, OCR has also been exercised on a real 28-page academic PDF (see
“Needs Verification” below). The trigger works and throughput was measured, but
subjective accuracy on noisy, skewed, or low-resolution scans is still not fully
validated.

### 3. Local dev server (Flask/Windows) had connectivity issues
Not a code bug — was resolved by using `127.0.0.1` instead of `localhost` and
checking Windows Firewall rules for Python. This gotcha is now documented in the
root `README.md`.

### 4. Sandbox network restrictions blocked TTS testing
In the Claude sandbox environment, `speech.platform.bing.com` (used by `edge-tts`)
was not reachable due to proxy allowlist restrictions. **This is NOT expected to
be an issue on Railway or a normal dev machine** — flagging only so nobody wastes
time debugging it as if it were a real bug. If Antigravity's sandbox has similar
network restrictions, the same false alarm may reoccur — test on an unrestricted
network to confirm.

### 5. Header/footer bleed — running boilerplate narrated on every page
**Found during:** Task 5 real-world test, 28-page academic PDF ("Introduction to AI
and Applications"). **Status: Fixed.**

Neither `pypdf` nor Tesseract distinguish body text from running headers/footers.
Every repeated author/course-code line was extracted and sent to TTS, producing a
53-minute audio file for a document that should have been far shorter.

**Fix applied:** two post-extraction passes run on the full `pages_text` list
before `chunk_text()` (covers both `pypdf` and OCR paths):
- `strip_repeated_boilerplate(threshold=0.6)` — drops any line appearing
  identically on ≥60% of pages. Exact whole-line match only; repeated words
  inside sentences are unaffected.
- `strip_page_numbers()` — drops standalone numeric lines (e.g. `"42"`, `"- 7 -"`).
  Page numbers differ per page so the 60% threshold won't catch them.

**Remaining risk:** academic PDFs with broken/unusual font encodings may make
`pypdf` extraction too sparse and trigger the OCR fallback unnecessarily — if OCR
output is meaningfully cleaner than plain `pypdf` on a text-layer PDF, that's a
text-extraction quality issue worth investigating (`pdfplumber` or `PyMuPDF` as
alternatives to `pypdf`).

**Known edge cases (backlog, not blockers):**
- ~~`strip_page_numbers()` won't catch worded footers like `"Page 3"` or `"Page 3 of 28"`~~ — **Fixed.** Regex now covers `Page N`, `Page N of M`, and `N of M` patterns.
- On very short documents (3–4 pages), a legitimately repeated section title could
  coincidentally hit the 60% threshold in `strip_repeated_boilerplate` and be stripped.
  Low probability; fix if it's actually observed, not before.

---


## 🟡 Needs Verification / Untested

1. **OCR accuracy and speed** — tested on a real 28-page academic PDF.
   Measured OCR throughput: **~43 sec/page** (~20 min total for 28 pages).
   Use this figure for any page-count cap or upload-time warning in the UI.
   Accuracy on real academic scans still needs a subjective quality check;
   also flag if OCR output is materially cleaner than `pypdf` on the same doc
   (would indicate a text-extraction quality issue, not a true "needs OCR" case).

2. **Progress % / ETA accuracy** — the backend now writes `eta_seconds` every
   second from a phase-specific wall-clock estimate
   (`total_chars / (TTS_CHARS_PER_SECOND × TTS_CONCURRENCY)`), instead of only
   after each chunk. The React UI hides the estimate for the first two extraction
   pages, then shows it below the clock; the clock hands are driven by the
   remaining/total ETA. Verified on the 40-page test PDF: the value ticks down
   every second and the hands move proportionally. The estimate is deliberately
   conservative — on a fast network the job may finish with time left on the
   clock, and under Microsoft-side throttling it can sit at `1s` briefly before
   completion. Not yet validated on a 100+ page document.

3. **Concurrent users** — gunicorn with `--workers 1` (Free tier, single CPU).
   Background jobs run in Python threads within the worker, and each active job
   now opens up to `TTS_CONCURRENCY` (default 4) outbound Edge TTS connections.
   Fine for personal/small-scale use; multiple simultaneous large uploads will
   contend for the single worker and network. A real task queue (Celery/RQ +
   Redis) would be needed for higher traffic.

4. ~~**Job storage is in-memory** (`JOBS` dict in `app.py`)~~. — **Fixed.** Jobs are now stored
   in SQLite (`/tmp/jobs.db`). Survives worker crashes and health-check restarts within the
   same container. `/tmp` is still wiped on Render redeploy, so a full redeploy during an
   active conversion still loses the job — just as before, but now it's an ephemeral-storage
   issue, not a Python-dict issue. `ocr_page_number` column was missing from the original
   schema (silent `OperationalError` on every OCR page); added and migrated via `ALTER TABLE`
   on startup.
   - **Current config: `--workers 1`** (set in both `Procfile` and `Dockerfile`).
     Single-worker is the intentional v1 launch config.
     **Follow-up (lower priority now):** migrate to Redis or SQLite-backed queue before
     bumping workers or enabling zero-downtime deploys.

5. ~~**No cleanup of `/tmp/pdf_audio`**~~ — **Fixed.** `_cleanup_old_audio` daemon
   thread deletes audio files older than 2 h, runs every 10 min.

6. ~~**Encrypted/password-protected PDFs**~~ — **Fixed.** `reader.is_encrypted` check
   in `extract_text_with_progress` raises a friendly `ValueError` before any page
   iteration; frontend shows a clean error message.

---

## 🟡 Frontend vs. Deployment Gap

- Two UIs exist:
  - `frontend/` — React 19 + Vite app used for all current UI work. Runs on
    `http://127.0.0.1:5173` and proxies `/convert`, `/progress`, `/audio` to Flask
    on port 5000.
  - `templates/index.html` — legacy vanilla UI served by Flask at `/`, and still
    the UI used by the Render deployment.
- `npm run build` emits `frontend/dist`, but Flask does not serve it. The React
  app must either be wired into Flask (serve `dist/index.html` + assets) or
  deployed separately before it reaches production.
- Verified in the React UI: live page/chunk progress, ETA countdown, countdown
  clock, drag-and-drop file display, animated voice/speed dropdowns, and result
  playback/download.

---

## 🟢 Performance — 2026-10-26

- TTS chunk synthesis is now parallel: up to `TTS_CONCURRENCY` (default `4`)
  chunks are synthesized concurrently with `asyncio.gather` + a semaphore, then
  concatenated in their original order. Measured on the 40-page test PDF:
  **93–151 s sequential → ~10 s** on a fast network, **26–36 s** when
  Microsoft-side throttling kicks in.
- `TTS_CHARS_PER_SECOND` (default `250`, per stream) seeds the ETA together with
  the concurrency factor.
- Frontend: `formatEta` no longer produces `1:60`; clock hands follow the
  countdown instead of jumping with chunk progress; headline/subtitle typography
  and the “Convert to audio” button were restyled (see `frontend/README.md`).

---

## 🟢 Deployment — Render (confirmed working)

**Live URL:** https://papervoice.onrender.com  
**Platform:** Render Free tier, Docker runtime, auto-detected from `Dockerfile` in repo root.  
**Confirmed in build log (2026-07-11):**
- `apt-get install tesseract-ocr poppler-utils` succeeded in Render's build sandbox
- All Python packages installed cleanly (pip step #11, 6.7 s)
- Gunicorn started on `0.0.0.0:5000`, worker pid booted
- Render auto-set `WEB_CONCURRENCY=1` (consistent with our `--workers 1` config)
- Port 5000 detected; brief network-config redeploy (normal Render behaviour), then live

**Note on `/tmp` persistence:** Render Free tier uses ephemeral storage — `/tmp` is
not persisted across deploys/restarts. Audio files vanish on redeploy anyway, so the
2-hour TTL cleanup is belt-and-suspenders rather than the primary expiry mechanism.
This is fine for v1.

---

## 📋 Feature Requests Still Open

- [x] Show real-time "Page X of Y" progress during extraction/OCR — verified in the React UI
- [x] Show ETA countdown during conversion — verified in the React UI; clock hands follow the remaining time
- [x] Auto-detect and OCR scanned PDFs without failing — verified on a real 28-page PDF; accuracy on noisy scans still worth a subjective check
- [ ] Serve the React build from Flask / Render (production currently uses `templates/index.html`)
- [ ] Add committed automated tests (current verification uses ad-hoc Playwright/API scripts outside the repo)
- [ ] Parallelize OCR page processing if scanned documents are a common upload (currently ~43 s/page, sequential)
- [x] Cleanup job for old temp files — audio files older than 2 h auto-deleted (`_cleanup_old_audio` thread)
- [x] Handle encrypted PDFs gracefully — `reader.is_encrypted` check in `extract_text_with_progress`,
      returns user-friendly error message
- [x] `/convert` input validation — `speed` field now parsed with try/except + clamped -50..+50
- [x] Worded page footers ("Page 3 of 28") — `strip_page_numbers` regex expanded to cover `Page N`, `Page N of M`, `N of M`
- [x] `ocr_page_number` missing from DB schema — caused silent `OperationalError` on every OCR page; column added + startup migration
- [x] Job state migrated from in-memory dict to SQLite (`/tmp/jobs.db`) — survives in-process restarts
- [ ] (Not yet started) Rate limiting / abuse prevention now that this is public-facing
- [ ] Container-level job persistence — SQLite at `/tmp` still wiped on Render redeploy; would need
      a persistent volume or external store (Redis) for zero-downtime deploys
