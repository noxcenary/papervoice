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
- `strip_page_numbers()` won't catch worded footers like `"Page 3"` or `"Page 3 of 28"` —
  those contain non-digit chars and won't match the regex. If QA hits a doc where this
  slips through, expand the regex then (don't pre-optimise).
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

2. **Progress % / ETA accuracy** — the ETA calculation is a simple linear
   extrapolation (elapsed time / % done * remaining %). This will be inaccurate
   early in the job (first chunk) and should smooth out. Not yet tested against
   a real long document to see how close the estimate lands.

3. **Concurrent users** — gunicorn with `--workers 1` (Free tier, single CPU).
   Background jobs run in Python threads within the worker, which works but
   doesn't scale well. Fine for personal/small-scale use; would need a real task
   queue (Celery/RQ + Redis) for anything higher-traffic.

4. **Job storage is in-memory** (`JOBS` dict in `app.py`). This means:
   - Restarting the server loses all in-progress/completed job records
   - **Confirmed failure (2026-07-11):** a `git push` during an active conversion
     triggers a Render redeploy — the old container is killed and its in-memory
     `JOBS` dict vanishes. The frontend's next `/progress/<job_id>` poll gets
     `404 Job not found`. The job, its progress, and any finished audio are
     unrecoverable. The only mitigation is: don't push new commits while a live
     test conversion is running.
   - Multiple gunicorn workers do NOT share this dict — a poll request could hit
     a different worker than the one processing the job and get a 404
   - **Current config: `--workers 1`** (set in both `Procfile` and `Dockerfile`).
     Single-worker is the intentional v1 launch config — avoids the dict-sharding
     bug at the cost of serialising all requests. Fine for personal use.
     **Follow-up (higher priority):** migrate job state to Redis or SQLite before
     bumping workers or relying on concurrent deploys.

5. ~~**No cleanup of `/tmp/pdf_audio`**~~ — **Fixed.** `_cleanup_old_audio` daemon
   thread deletes audio files older than 2 h, runs every 10 min.

6. ~~**Encrypted/password-protected PDFs**~~ — **Fixed.** `reader.is_encrypted` check
   in `extract_text_with_progress` raises a friendly `ValueError` before any page
   iteration; frontend shows a clean error message.

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

- [ ] Show real-time "Page X of Y" progress during extraction/OCR (backend supports
      this now — verify frontend displays it correctly)
- [ ] Show ETA countdown during conversion (backend supports this — verify accuracy)
- [ ] Auto-detect and OCR scanned PDFs without failing (implemented, untested on real scans)
- [x] Cleanup job for old temp files — audio files older than 2 h auto-deleted (`_cleanup_old_audio` thread)
- [x] Handle encrypted PDFs gracefully — `reader.is_encrypted` check in `extract_text_with_progress`,
      returns user-friendly error message
- [x] `/convert` input validation — `speed` field now parsed with try/except + clamped -50..+50
- [ ] (Not yet started) Rate limiting / abuse prevention now that this is public-facing
- [ ] Migrate job state from in-memory `JOBS` dict to Redis or SQLite — any container
      restart (deploy, crash, scale) loses in-flight conversions. Confirmed failure:
      a `git push` during an active job kills the old container's `JOBS` dict,
      leaving the user with a `404 Job not found` error and unrecoverable audio.
