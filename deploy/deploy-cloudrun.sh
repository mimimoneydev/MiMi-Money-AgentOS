#!/usr/bin/env bash
# Build + deploy MiMi AgentOS to Cloud Run (scale-to-zero, near-zero cost).
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?export PROJECT_ID first}"
REGION="${REGION:-africa-south1}"
SERVICE_NAME="${SERVICE_NAME:-mimi-agentos}"
SA_EMAIL="${SA_EMAIL:-mimi-agentos@${PROJECT_ID}.iam.gserviceaccount.com}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE_TAG="${IMAGE_TAG:-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo latest)}"

gcloud config set project "$PROJECT_ID" >/dev/null

echo "[mimi] submitting build (repo root Dockerfile)…"
gcloud builds submit --tag "gcr.io/$PROJECT_ID/$SERVICE_NAME:$IMAGE_TAG" "$REPO_ROOT"

echo "[mimi] deploying to Cloud Run ($REGION)…"
gcloud run deploy "$SERVICE_NAME" \
  --image "gcr.io/$PROJECT_ID/$SERVICE_NAME:$IMAGE_TAG" \
  --region "$REGION" \
  --service-account "$SA_EMAIL" \
  --allow-unauthenticated \
  --min-instances 0 --max-instances 2 \
  --cpu 1 --memory 512Mi --concurrency 40 \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=$PROJECT_ID,NODE_ENV=production" \
  --set-secrets "MIMI_GEMINI_API_KEY=MIMI_GEMINI_API_KEY:latest"

URL=$(gcloud run services describe "$SERVICE_NAME" --region "$REGION" --format 'value(status.url)')
echo "[mimi] deployed: $URL"
echo "[mimi] open $URL and use the MiMI AgentOS section in the sidebar."
echo "[mimi] NOTE: --allow-unauthenticated exposes the board login (Paperclip auth still applies)."
echo "       For private demos drop that flag and access via IAM-invoked browser or your SSO."

# ---------------------------------------------------------------------------
# Optional: deploy the real google-adk Python runtime as its own service and
# point the control plane at it (MIMI_ADK_RUNTIME_URL). Skip by setting
# SKIP_ADK_RUNTIME=1.
# ---------------------------------------------------------------------------
if [[ "${SKIP_ADK_RUNTIME:-0}" != "1" ]]; then
  ADK_SERVICE="${ADK_SERVICE:-mimi-agent-runtime}"
  echo "[mimi] building google-adk runtime service ($ADK_SERVICE)…"
  gcloud builds submit --tag "gcr.io/$PROJECT_ID/$ADK_SERVICE:$IMAGE_TAG" "$REPO_ROOT/services/mimi-adk-runtime"

  gcloud run deploy "$ADK_SERVICE" \
    --image "gcr.io/$PROJECT_ID/$ADK_SERVICE:$IMAGE_TAG" \
    --region "$REGION" \
    --service-account "$SA_EMAIL" \
    --ingress internal \
    --min-instances 0 --max-instances 2 \
    --cpu 1 --memory 512Mi --concurrency 20 \
    --set-env-vars "MIMI_GEMINI_MISSION_MODEL=${MIMI_GEMINI_MISSION_MODEL:-${MIMI_GEMINI_MODEL:-gemini-3.6-flash}},MIMI_GEMINI_LIGHT_MODEL=${MIMI_GEMINI_LIGHT_MODEL:-gemini-3.5-flash}" \
    --set-secrets "GOOGLE_API_KEY=MIMI_GEMINI_API_KEY:latest"

  ADK_URL=$(gcloud run services describe "$ADK_SERVICE" --region "$REGION" --format 'value(status.url)')
  echo "[mimi] ADK runtime deployed: $ADK_URL"
  echo "[mimi] set MIMI_ADK_RUNTIME_URL=$ADK_URL on the $SERVICE_NAME service to route runs through real google-adk:"
  echo "       gcloud run services update $SERVICE_NAME --region $REGION --update-env-vars MIMI_ADK_RUNTIME_URL=$ADK_URL"
fi
