"""
📖 Papervoice — PDF to Speech Web App (v2)
Upload any PDF, pick a voice, listen or download the audio.
v2 adds: async job processing with live progress, ETA, and automatic
OCR fallback for scanned/image-only PDFs.

100% free — Microsoft Edge TTS + Flask + Tesseract OCR.

See ISSUES.md for known limitations, especially around OCR deployment
requirements and in-memory job storage.
"""

import asyncio
import os
import sqlite3
import threading
import time
import uuid
from pathlib import Path

import edge_tts
from flask import Flask, render_template, request, send_file, jsonify
from pypdf import PdfReader

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024  # 25 MB upload limit

UPLOAD_DIR = Path("/tmp/pdf_uploads")
AUDIO_DIR = Path("/tmp/pdf_audio")
UPLOAD_DIR.mkdir(exist_ok=True, parents=True)
AUDIO_DIR.mkdir(exist_ok=True, parents=True)

VOICES = {
    "en-US-AriaNeural":    "American Female — warm, clear",
    "en-US-GuyNeural":     "American Male — confident, natural",
    "en-GB-SoniaNeural":   "British Female — crisp, professional",
    "en-GB-RyanNeural":    "British Male — deep, calm",
    "en-IN-NeerjaNeural":  "Indian Female — warm, familiar",
    "en-IN-PrabhatNeural": "Indian Male — clear, friendly",
    "en-AU-NatashaNeural": "Australian Female — relaxed",
    "en-AU-WilliamNeural": "Australian Male — casual",
    "en-US-JennyNeural":   "American Female — friendly, upbeat",
    "en-GB-LibbyNeural":   "British Female — young, energetic",
}

MAX_CHARS_PER_CHUNK = 8000
MIN_WORDS_PER_PAGE_BEFORE_OCR = 20  # below this, assume scanned & try OCR
TTS_CHARS_PER_SECOND = float(os.environ.get("TTS_CHARS_PER_SECOND", "250"))
TTS_CONCURRENCY = max(1, int(os.environ.get("TTS_CONCURRENCY", "4")))

# ══════════════════════════════════════════════════════════════════════════
# 🗄️  SQLITE JOB STORE — persists across process restarts within the same
# container.  Survives worker crashes, health-check restarts, and brief
# hiccups, but *not* a full redeploy (Render wipes /tmp on deploy).
# See ISSUES.md for limits.  Single-file, zero external deps.
# ══════════════════════════════════════════════════════════════════════════
DB_PATH = os.environ.get("JOBS_DB_PATH", "/tmp/jobs.db")

_SQL_INIT = """
CREATE TABLE IF NOT EXISTS jobs (
    job_id          TEXT PRIMARY KEY,
    status          TEXT DEFAULT 'processing',
    phase           TEXT DEFAULT 'starting',
    pages_total     INTEGER,
    pages_done      INTEGER DEFAULT 0,
    chunks_total    INTEGER,
    chunks_done     INTEGER DEFAULT 0,
    eta_seconds     REAL,
    ocr_used        INTEGER DEFAULT 0,
    ocr_page_number INTEGER,
    ocr_error       TEXT,
    word_count      INTEGER,
    audio_url       TEXT,
    error           TEXT
)
"""


def _get_conn():
    c = sqlite3.connect(DB_PATH, timeout=5)
    c.row_factory = sqlite3.Row
    return c


def _init_jobs_db():
    with _get_conn() as c:
        c.execute(_SQL_INIT)
        # Migrate existing DBs: add ocr_page_number if missing
        existing = {row[1] for row in c.execute("PRAGMA table_info(jobs)")}
        if "ocr_page_number" not in existing:
            c.execute("ALTER TABLE jobs ADD COLUMN ocr_page_number INTEGER")
        c.commit()


_init_jobs_db()


def update_job(job_id, **kwargs):
    if not kwargs:
        return
    cols = []
    vals = []
    for k, v in kwargs.items():
        cols.append(f"{k}=?")
        vals.append(v if k != "ocr_used" else int(v))
    vals.append(job_id)
    sql = f"UPDATE jobs SET {', '.join(cols)} WHERE job_id=?"
    with _get_conn() as c:
        c.execute(sql, vals)
        c.commit()


def get_job(job_id):
    with _get_conn() as c:
        row = c.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
    if row is None:
        return {}
    d = dict(row)
    d["ocr_used"] = bool(d["ocr_used"])
    return d


# ══════════════════════════════════════════════════════════════════════════
# 🧹  AUDIO CLEANUP — delete files older than AUDIO_TTL_SECONDS (default 2 h)
# Runs in a daemon thread every 10 minutes so disk doesn't fill on Railway.
# ══════════════════════════════════════════════════════════════════════════
AUDIO_TTL_SECONDS = 7200  # 2 hours


def _cleanup_old_audio():
    while True:
        try:
            cutoff = time.time() - AUDIO_TTL_SECONDS
            for f in AUDIO_DIR.iterdir():
                if f.is_file() and f.stat().st_mtime < cutoff:
                    f.unlink(missing_ok=True)
        except Exception:
            pass  # never crash the cleanup thread
        time.sleep(600)  # check every 10 minutes


threading.Thread(target=_cleanup_old_audio, daemon=True).start()


# ══════════════════════════════════════════════════════════════════════════
# 📄  PDF TEXT EXTRACTION (with OCR fallback per page)
# ══════════════════════════════════════════════════════════════════════════
def extract_page_text(page) -> str:
    return (page.extract_text() or "").strip()


def ocr_page(pdf_path: Path, page_number: int) -> str:
    """
    Rasterize a single page and run Tesseract OCR on it.
    Requires system binaries: tesseract-ocr, poppler-utils (see ISSUES.md).
    NOTE: untested end-to-end — flagged in ISSUES.md.
    """
    try:
        from pdf2image import convert_from_path
        import pytesseract
    except ImportError as e:
        raise RuntimeError(
            "OCR dependencies missing. Install pytesseract + pdf2image, "
            "and ensure tesseract-ocr + poppler-utils system binaries are "
            "installed. See ISSUES.md for deployment notes."
        ) from e

    images = convert_from_path(
        str(pdf_path), first_page=page_number + 1, last_page=page_number + 1, dpi=200
    )
    if not images:
        return ""
    return pytesseract.image_to_string(images[0]).strip()


# ══════════════════════════════════════════════════════════════════════════
# 🧼  BOILERPLATE REMOVAL — headers/footers + standalone page numbers
# Runs on the full page list after extraction (both pypdf and OCR paths).
# ══════════════════════════════════════════════════════════════════════════
def strip_repeated_boilerplate(pages_text: list[str], threshold: float = 0.6) -> list[str]:
    """
    Drop any line that appears on more than `threshold` fraction of pages.
    Normalizes lines by stripping trailing numbers/spaces to catch headers or
    footers that have page numbers appended (e.g. 'Prepared by: Author 3').
    Requires at least 2 pages; otherwise single-page documents have count=1 >= cutoff
    which falsely strips every line of the document.
    """
    if not pages_text or len(pages_text) < 2:
        return pages_text

    import re
    from collections import Counter

    def normalize(line: str) -> str:
        s = line.strip()
        # Remove trailing digits, dashes, and spaces
        return re.sub(r'[\s\-–—\d]*$', '', s)

    line_counts: Counter = Counter()
    for page in pages_text:
        # count each normalized line once per page
        for line in set(page.splitlines()):
            norm = normalize(line)
            if norm:
                line_counts[norm] += 1

    cutoff = max(2, len(pages_text) * threshold)
    boilerplate = {norm for norm, count in line_counts.items() if count >= cutoff}

    cleaned = []
    for page in pages_text:
        kept = [ln for ln in page.splitlines() if normalize(ln) not in boilerplate]
        cleaned.append("\n".join(kept))

    # Safety: if stripping boilerplate emptied the text, fallback to original
    if not "\n\n".join(cleaned).strip() and any(p.strip() for p in pages_text):
        return pages_text

    return cleaned



def strip_page_numbers(pages_text: list[str]) -> list[str]:
    """
    Drop standalone lines that are purely numeric (e.g. "42", "- 7 -")
    or common worded page-number patterns ("Page 3", "Page 3 of 28",
    "3 of 28"). Page numbers differ per page so repeat-threshold misses them.
    """
    import re
    page_num_re = re.compile(
        r'^[\s\-–—]*\d+[\s\-–—]*$'                  # pure digit(s): "42", "- 7 -"
        r'|^[Pp]age\s+\d+(\s+of\s+\d+)?[\s\-–—]*$'  # "Page 3", "Page 3 of 28"
        r'|^\d+\s+of\s+\d+[\s\-–—]*$'               # "3 of 28"
    )
    cleaned = []
    for page in pages_text:
        kept = [ln for ln in page.splitlines() if not page_num_re.match(ln)]
        cleaned.append("\n".join(kept))
    return cleaned


def extract_text_with_progress(pdf_path: Path, job_id: str) -> str:
    reader = PdfReader(str(pdf_path))
    if reader.is_encrypted:
        raise ValueError(
            "This PDF is password-protected — please upload an unlocked copy."
        )
    total_pages = len(reader.pages)
    update_job(job_id, phase="extracting", pages_total=total_pages, pages_done=0)

    pages_text = []
    ocr_used = False
    extraction_start = time.time()

    for i, page in enumerate(reader.pages):
        text = extract_page_text(page)

        # Likely scanned/image-only page — fall back to OCR
        if len(text.split()) < MIN_WORDS_PER_PAGE_BEFORE_OCR:
            update_job(job_id, phase="ocr", ocr_page_number=i + 1)
            try:
                ocr_text = ocr_page(pdf_path, i)
                if len(ocr_text.split()) > len(text.split()):
                    text = ocr_text
                    ocr_used = True
            except Exception as e:
                # OCR failed — keep whatever text extraction found, don't crash the job
                update_job(job_id, ocr_error=str(e))

        pages_text.append(text)
        update_job(job_id, pages_done=i + 1, phase="extracting",
                   eta_seconds=round(((total_pages - (i + 1)) * (time.time() - extraction_start)) / (i + 1)))

    # Remove headers/footers and standalone page numbers before joining.
    # Both passes operate on the full page list so the 60% threshold has
    # global context — must happen here, not inside the per-page loop.
    pages_text = strip_repeated_boilerplate(pages_text)
    pages_text = strip_page_numbers(pages_text)

    full_text = "\n\n".join(pages_text)
    update_job(job_id, ocr_used=ocr_used)

    if not full_text.strip():
        raise ValueError(
            "No text could be extracted, even with OCR. This PDF may be "
            "corrupted, empty, or in an unsupported format."
        )

    return full_text


def clean_text(text: str) -> str:
    lines = text.split("\n")
    cleaned = [
        line.strip() for line in lines
        if line.strip() and not (line.strip().isdigit() and len(line.strip()) <= 4)
    ]
    return " ".join(cleaned)


def chunk_text(text: str, size: int = MAX_CHARS_PER_CHUNK):
    words = text.split(" ")
    chunks, current = [], ""
    for word in words:
        if len(current) + len(word) + 1 > size:
            chunks.append(current)
            current = word
        else:
            current = f"{current} {word}".strip()
    if current:
        chunks.append(current)
    return chunks


# ══════════════════════════════════════════════════════════════════════════
# 🔊  TEXT → SPEECH (chunked, with progress + ETA)
# ══════════════════════════════════════════════════════════════════════════
async def synthesize_with_progress(text: str, voice: str, rate: str, output_path: Path, job_id: str):
    chunks = chunk_text(text)
    total_chunks = len(chunks)
    total_chars = sum(len(chunk) for chunk in chunks)
    concurrency = max(1, min(TTS_CONCURRENCY, total_chunks))
    expected_seconds = max(1.0, total_chars / (TTS_CHARS_PER_SECOND * concurrency))

    start_time = time.time()
    update_job(
        job_id,
        phase="converting",
        chunks_total=total_chunks,
        chunks_done=0,
        eta_seconds=max(1, round(expected_seconds)),
    )

    async def eta_ticker():
        # Count down in real time even while a long chunk is being synthesized.
        while True:
            remaining = expected_seconds - (time.time() - start_time)
            update_job(job_id, eta_seconds=max(1, round(remaining)))
            await asyncio.sleep(1)

    eta_task = asyncio.create_task(eta_ticker())
    sem = asyncio.Semaphore(concurrency)
    chunks_done = 0

    async def synthesize_chunk(index: int, chunk: str) -> Path:
        nonlocal chunks_done
        async with sem:
            temp_path = output_path.parent / f"{output_path.stem}_part{index}.mp3"
            communicate = edge_tts.Communicate(chunk, voice, rate=rate)
            await communicate.save(str(temp_path))
            chunks_done += 1
            update_job(job_id, chunks_done=chunks_done)
            return temp_path

    try:
        temp_files = await asyncio.gather(
            *(synthesize_chunk(i, chunk) for i, chunk in enumerate(chunks))
        )

        if len(temp_files) == 1:
            temp_files[0].replace(output_path)
        else:
            with open(output_path, "wb") as outfile:
                for temp_path in temp_files:
                    with open(temp_path, "rb") as infile:
                        outfile.write(infile.read())
                    temp_path.unlink()
    finally:
        eta_task.cancel()
        try:
            await eta_task
        except asyncio.CancelledError:
            pass


# ══════════════════════════════════════════════════════════════════════════
# 🧵  BACKGROUND JOB RUNNER
# ══════════════════════════════════════════════════════════════════════════
def run_conversion_job(job_id: str, pdf_path: Path, audio_path: Path, voice: str, rate: str):
    try:
        raw_text = extract_text_with_progress(pdf_path, job_id)
        text = clean_text(raw_text)
        word_count = len(text.split())
        update_job(job_id, word_count=word_count)

        asyncio.run(synthesize_with_progress(text, voice, rate, audio_path, job_id))

        update_job(
            job_id,
            status="done",
            phase="done",
            audio_url=f"/audio/{job_id}",
            eta_seconds=0,
        )
    except Exception as e:
        update_job(job_id, status="error", error=str(e))
    finally:
        if pdf_path.exists():
            pdf_path.unlink()


# ══════════════════════════════════════════════════════════════════════════
# 🌐  ROUTES
# ══════════════════════════════════════════════════════════════════════════
@app.route("/")
def index():
    return render_template("index.html", voices=VOICES)



@app.route("/papervoice-icon-180.png")
def favicon():
    return send_from_directory(DIST_DIR, "papervoice-icon-180.png")


@app.route("/convert", methods=["POST"])
def convert():
    if "pdf" not in request.files:
        return jsonify({"error": "No PDF uploaded."}), 400

    file = request.files["pdf"]
    if file.filename == "" or not file.filename.lower().endswith(".pdf"):
        return jsonify({"error": "Please upload a valid PDF file."}), 400

    voice = request.form.get("voice", "en-US-AriaNeural")
    if voice not in VOICES:
        return jsonify({"error": "Invalid voice selected."}), 400

    try:
        speed = int(request.form.get("speed", "0"))
    except ValueError:
        return jsonify({"error": "Speed must be an integer between -50 and 50."}), 400
    speed = max(-50, min(50, speed))
    rate = f"{'+' if speed >= 0 else ''}{speed}%"

    job_id = str(uuid.uuid4())
    pdf_path = UPLOAD_DIR / f"{job_id}.pdf"
    audio_path = AUDIO_DIR / f"{job_id}.mp3"
    file.save(str(pdf_path))

    with _get_conn() as c:
        c.execute(
            "INSERT INTO jobs (job_id, status, phase) VALUES (?, 'processing', 'starting')",
            (job_id,),
        )
        c.commit()

    thread = threading.Thread(
        target=run_conversion_job,
        args=(job_id, pdf_path, audio_path, voice, rate),
        daemon=True,
    )
    thread.start()

    return jsonify({"job_id": job_id})


@app.route("/progress/<job_id>")
def progress(job_id):
    try:
        job = get_job(job_id)
        if not job:
            return jsonify({"error": "Job not found."}), 404
        return jsonify(job)
    except Exception as e:
        return jsonify({"error": f"Internal error: {e}"}), 500


@app.route("/audio/<job_id>")
def get_audio(job_id):
    audio_path = AUDIO_DIR / f"{job_id}.mp3"
    if not audio_path.exists():
        return jsonify({"error": "Audio not found or expired."}), 404
    return send_file(str(audio_path), mimetype="audio/mpeg", as_attachment=False)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
