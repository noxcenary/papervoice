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
import io
import os
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

# ══════════════════════════════════════════════════════════════════════════
# ⚠️  IN-MEMORY JOB STORE
#
# See ISSUES.md #4 — this will NOT work correctly across multiple gunicorn
# workers, since each worker has its own copy of this dict. A poll request
# can land on a worker that never processed the job and get a false 404.
# Fine for local testing / single-worker deploys. Needs Redis/SQLite for
# anything more robust.
# ══════════════════════════════════════════════════════════════════════════
JOBS = {}
JOBS_LOCK = threading.Lock()


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


def update_job(job_id, **kwargs):
    with JOBS_LOCK:
        if job_id in JOBS:
            JOBS[job_id].update(kwargs)


def get_job(job_id):
    with JOBS_LOCK:
        return dict(JOBS.get(job_id, {}))


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
    """
    if not pages_text:
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

    cutoff = len(pages_text) * threshold
    boilerplate = {norm for norm, count in line_counts.items() if count >= cutoff}

    cleaned = []
    for page in pages_text:
        kept = [ln for ln in page.splitlines() if normalize(ln) not in boilerplate]
        cleaned.append("\n".join(kept))
    return cleaned



def strip_page_numbers(pages_text: list[str]) -> list[str]:
    """
    Drop standalone lines that are purely numeric (e.g. "42", "- 7 -").
    Page numbers differ per page so the repeat-threshold won't catch them.
    """
    import re
    page_num_re = re.compile(r'^[\s\-–—]*\d+[\s\-–—]*$')
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
    update_job(job_id, phase="converting", chunks_total=total_chunks, chunks_done=0)

    start_time = time.time()
    temp_files = []

    for i, chunk in enumerate(chunks):
        temp_path = output_path.parent / f"{output_path.stem}_part{i}.mp3"
        communicate = edge_tts.Communicate(chunk, voice, rate=rate)
        await communicate.save(str(temp_path))
        temp_files.append(temp_path)

        elapsed = time.time() - start_time
        done = i + 1
        avg_per_chunk = elapsed / done
        remaining = total_chunks - done
        eta_seconds = round(avg_per_chunk * remaining)

        update_job(job_id, chunks_done=done, eta_seconds=eta_seconds)

    if len(temp_files) == 1:
        temp_files[0].rename(output_path)
    else:
        with open(output_path, "wb") as outfile:
            for temp_path in temp_files:
                with open(temp_path, "rb") as infile:
                    outfile.write(infile.read())
                temp_path.unlink()


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

    with JOBS_LOCK:
        JOBS[job_id] = {
            "status": "processing",
            "phase": "starting",
            "pages_total": None,
            "pages_done": 0,
            "chunks_total": None,
            "chunks_done": 0,
            "eta_seconds": None,
            "ocr_used": False,
        }

    thread = threading.Thread(
        target=run_conversion_job,
        args=(job_id, pdf_path, audio_path, voice, rate),
        daemon=True,
    )
    thread.start()

    return jsonify({"job_id": job_id})


@app.route("/progress/<job_id>")
def progress(job_id):
    job = get_job(job_id)
    if not job:
        return jsonify({"error": "Job not found."}), 404
    return jsonify(job)


@app.route("/audio/<job_id>")
def get_audio(job_id):
    audio_path = AUDIO_DIR / f"{job_id}.mp3"
    if not audio_path.exists():
        return jsonify({"error": "Audio not found or expired."}), 404
    return send_file(str(audio_path), mimetype="audio/mpeg", as_attachment=False)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
