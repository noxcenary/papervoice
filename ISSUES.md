# Papervoice — Known Issues & Handoff Notes

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
**Still needs testing on a REAL scanned document** (multi-page, actual scan
quality/noise, skewed pages, etc.) — the sandbox test used a clean synthetic
image, which is a best-case scenario. Real scans may have lower OCR accuracy.

### 3. Local dev server (Flask/Windows) had connectivity issues
Not a code bug — was resolved by using `127.0.0.1` instead of `localhost` and
checking Windows Firewall rules for Python. Worth adding a note in README about
this being a common Windows dev gotcha.

### 4. Sandbox network restrictions blocked TTS testing
In the Claude sandbox environment, `speech.platform.bing.com` (used by `edge-tts`)
was not reachable due to proxy allowlist restrictions. **This is NOT expected to
be an issue on Railway or a normal dev machine** — flagging only so nobody wastes
time debugging it as if it were a real bug. If Antigravity's sandbox has similar
network restrictions, the same false alarm may reoccur — test on an unrestricted
network to confirm.

---

## 🟡 Needs Verification / Untested

1. **OCR accuracy and speed** — no real scanned PDF has been tested against the
   new OCR fallback path. Need to verify: (a) OCR actually triggers correctly on
   image-only pages, (b) extracted OCR text quality is acceptable, (c) OCR doesn't
   add unacceptable processing time for large scanned documents.

2. **Progress % / ETA accuracy** — the ETA calculation is a simple linear
   extrapolation (elapsed time / % done * remaining %). This will be inaccurate
   early in the job (first chunk) and should smooth out. Not yet tested against
   a real long document to see how close the estimate lands.

3. **Concurrent users** — Flask + gunicorn with 2 workers. If two people convert
   large PDFs simultaneously, one may stall waiting for a worker. Background jobs
   run in Python threads within the request-serving process, which works but
   doesn't scale well. Fine for personal/small-scale use; would need a real task
   queue (Celery/RQ + Redis) for anything higher-traffic.

4. **Job storage is in-memory** (`JOBS` dict in `app.py`). This means:
   - Restarting the server loses all in-progress/completed job records
   - Multiple gunicorn workers do NOT share this dict — a poll request could hit
     a different worker than the one processing the job and get a 404
   - **Current config: `--workers 1`** (set in both `Procfile` and `Dockerfile`).
     Single-worker is the intentional v1 launch config — avoids the dict-sharding
     bug at the cost of serialising all requests. Fine for personal / shared-with-friends
     use. Follow-up: migrate job state to Redis or SQLite before bumping workers.

5. **No cleanup of `/tmp/pdf_audio` and `/tmp/pdf_uploads`** — files accumulate
   over time with no expiry. Fine short-term, but will fill disk on a long-running
   deployment. Needs a cleanup routine (e.g., delete files older than N hours).

6. **Encrypted/password-protected PDFs** — not handled. `pypdf` will likely raise
   an exception that isn't caught with a friendly error message. Untested.

---

## 🟢 Deployment Requirements (New — for OCR support)

The OCR fallback requires **system-level binaries** that are NOT Python packages:
- `tesseract-ocr` (the OCR engine itself)
- `poppler-utils` (for rasterizing PDF pages to images, via `pdf2image`)

**This is the biggest deployment risk.** Railway's default Python build (via
Railpack, as seen in this project's earlier build logs) installs Python packages
via pip but does NOT automatically install system/apt packages like Tesseract.

You will likely need one of:
- A `railpack.json` config that specifies additional apt packages (check current
  Railway/Railpack docs for the correct syntax — this may have changed)
- OR switch to a Dockerfile-based deploy where you can explicitly
  `apt-get install tesseract-ocr poppler-utils`
- OR find a Railway template/buildpack that includes these pre-installed

**Action item:** confirm the correct way to install system packages on Railway's
current build system before assuming OCR will work in production. It has only
been tested with these binaries available locally.

---

## 📋 Feature Requests Still Open

- [ ] Show real-time "Page X of Y" progress during extraction/OCR (backend supports
      this now — verify frontend displays it correctly)
- [ ] Show ETA countdown during conversion (backend supports this — verify accuracy)
- [ ] Auto-detect and OCR scanned PDFs without failing (implemented, untested on real scans)
- [x] Cleanup job for old temp files — audio files older than 2 h auto-deleted (`_cleanup_old_audio` thread)
- [x] Handle encrypted PDFs gracefully — `reader.is_encrypted` check in `extract_text_with_progress`,
      returns user-friendly error message
- [x] `/convert` input validation — `speed` field now parsed with try/except + clamped -50..+50
- [ ] (Not yet started) Rate limiting / abuse prevention now that this is public-facing
