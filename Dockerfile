# Using a Dockerfile instead of Railway's default Python buildpack because
# OCR requires system binaries (tesseract-ocr, poppler-utils) that aren't
# installed by pip alone. See ISSUES.md for context.
#
# UNTESTED — flagged for verification in Antigravity. Confirm Railway picks
# this up automatically (it should, when a Dockerfile is present in repo root)
# and that the apt-get install step succeeds in Railway's build environment.

FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=5000
EXPOSE 5000

CMD ["gunicorn", "app:app", "--timeout", "600", "--workers", "1", "--bind", "0.0.0.0:5000"]
