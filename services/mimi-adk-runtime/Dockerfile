# MiMi ADK Runtime (google-adk Python service)
FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

COPY pyproject.toml README.md ./
COPY mimi_adk ./mimi_adk
RUN pip install --no-cache-dir .

# Cloud Run injects PORT; uvicorn binds it.
CMD exec uvicorn mimi_adk.service:app --host 0.0.0.0 --port ${PORT:-9700}
