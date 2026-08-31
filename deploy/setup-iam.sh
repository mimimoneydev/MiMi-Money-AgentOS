#!/usr/bin/env bash
# Minimal-IAM service account for MiMi AgentOS on Cloud Run.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?export PROJECT_ID first}"
SA_NAME="${SA_NAME:-mimi-agentos}"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud config set project "$PROJECT_ID" >/dev/null

if ! gcloud iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" \
    --display-name="MiMi AgentOS runtime (Cloud Run + Pub/Sub + Firestore + Gemini)"
fi

for ROLE in \
  roles/run.invoker \
  roles/pubsub.publisher \
  roles/pubsub.subscriber \
  roles/datastore.user \
  roles/secretmanager.secretAccessor; do
  echo "[mimi] granting $ROLE → $SA_EMAIL"
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SA_EMAIL" --role="$ROLE" --condition=None -q >/dev/null
done

echo "[mimi] done. Service account: $SA_EMAIL"
