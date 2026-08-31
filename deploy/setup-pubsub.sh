#!/usr/bin/env bash
# Provision all MiMI Pub/Sub topics (+ a push subscription example).
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?export PROJECT_ID first}"
REGION="${REGION:-africa-south1}"
SERVICE_NAME="${SERVICE_NAME:-mimi-agentos}"

gcloud config set project "$PROJECT_ID" >/dev/null

TOPICS=(
  mimi.transactions mimi.payments mimi.fraud mimi.compliance mimi.risk
  mimi.reconciliation mimi.treasury mimi.support mimi.reporting
  mimi.lifecycle mimi.human-review mimi.audit mimi.notifications
)

for TOPIC in "${TOPICS[@]}"; do
  if gcloud pubsub topics describe "$TOPIC" >/dev/null 2>&1; then
    echo "[mimi] topic exists: $TOPIC"
  else
    gcloud pubsub topics create "$TOPIC"
    echo "[mimi] created topic: $TOPIC"
  fi
done

# Example pull subscription for the audit trail sink (retains 7 days).
if ! gcloud pubsub subscriptions describe mimi-audit-sink >/dev/null 2>&1; then
  gcloud pubsub subscriptions create mimi-audit-sink --topic=mimi.audit \
    --message-retention-duration=7d \
    --ack-deadline=30 \
    --dead-letter-topic=mimi.audit --max-delivery-attempts=5 2>/dev/null ||
    gcloud pubsub subscriptions create mimi-audit-sink --topic=mimi.audit \
      --message-retention-duration=7d --ack-deadline=30 || true
  echo "[mimi] created subscription: mimi-audit-sink"
fi

echo "[mimi] ${#TOPICS[@]} topics ready in $PROJECT_ID."
echo "[mimi] The app publishes over REST with ADC on Cloud Run — no push config needed."
