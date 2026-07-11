# Using a Dockerfile instead of Render's default Python buildpack because
# OCR requires system binaries (tesseract-ocr, poppler-utils) that aren't
# installed by pip alone. See ISSUES.md for context.
#
# VERIFIED: Render auto-detects this Dockerfile, apt-get install succeeds
# in the build sandbox, and the service starts cleanly on port 5000.
# Live at https://papervoice.onrender.com

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
