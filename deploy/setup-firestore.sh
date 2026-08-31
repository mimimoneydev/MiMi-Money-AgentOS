#!/usr/bin/env bash
# Firestore Memory Bank provisioning note + optional region hint.
# Collections are schemaless and created lazily by @mimi/agentos-core, so this
# only ensures the database exists in the chosen region.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?export PROJECT_ID first}"
REGION="${REGION:-africa-south1}"

gcloud config set project "$PROJECT_ID" >/dev/null

echo "[mimi] ensuring Firestore database exists (region hint: $REGION)"
gcloud firestore databases describe --database='(default)' >/dev/null 2>&1 || {
  gcloud firestore databases create --location="$REGION" --type=firestore-native
}

cat <<'EOF'
[mimi] Firestore ready. Collections created lazily by the app:
  agents, customers, wallets, transactions, workflows, workflow_steps,
  agent_runs, agent_events, policies, permissions, human_reviews,
  audit, notifications, treasury_accounts, cases, reports
EOF
