#!/usr/bin/env bash
# Store the Gemini API key in Secret Manager (never in env files or images).
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?export PROJECT_ID first}"
SECRET_NAME="${SECRET_NAME:-MIMI_GEMINI_API_KEY}"

gcloud config set project "$PROJECT_ID" >/dev/null

if [ -z "${MIMI_GEMINI_API_KEY:-}" ]; then
  echo "Paste your Gemini API key (https://aistudio.google.com/apikey):"
  read -r KEY
else
  KEY="$MIMI_GEMINI_API_KEY"
fi
[ -n "$KEY" ] || { echo "empty key"; exit 1; }

printf '%s' "$KEY" | gcloud secrets create "$SECRET_NAME" --data-file=- 2>/dev/null ||
  printf '%s' "$KEY" | gcloud secrets versions add "$SECRET_NAME" --data-file=-

echo "[mimi] secret '$SECRET_NAME' stored."
