# Build React/Vite frontend
FROM node:22-alpine AS frontend-build

WORKDIR /frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build


# Python runtime
FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Copy the React production build into the Python image
COPY --from=frontend-build /frontend/dist /app/frontend/dist

ENV PORT=5000
EXPOSE 5000

CMD ["gunicorn", "wsgi:application", "--timeout", "600", "--workers", "1", "--bind", "0.0.0.0:5000"]