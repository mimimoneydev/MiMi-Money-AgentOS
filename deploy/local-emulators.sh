#!/usr/bin/env bash
# Start Pub/Sub + Firestore emulators for fully-local Google API parity.
set -euo pipefail

command -v gcloud >/dev/null || { echo "gcloud CLI required (https://cloud.google.com/sdk)"; exit 1; }

echo "[mimi] starting Pub/Sub emulator on :8085"
gcloud beta emulators pubsub start --host-port=localhost:8085 &
PUBSUB_PID=$!

echo "[mimi] starting Firestore emulator on :8080"
gcloud beta emulators firestore start --host-port=localhost:8080 &
FIRESTORE_PID=$!

trap 'kill $PUBSUB_PID $FIRESTORE_PID 2>/dev/null || true' EXIT

export PUBSUB_PROJECT_ID="${PUBSUB_PROJECT_ID:-mimi-local}"
export FIRESTORE_PROJECT_ID="${FIRESTORE_PROJECT_ID:-mimi-local}"
echo "[mimi] emulators running. In another shell run:"
echo "  export PUBSUB_EMULATOR_HOST=localhost:8085 FIRESTORE_EMULATOR_HOST=127.0.0.1:8080"
echo "  export PUBSUB_PROJECT_ID=$PUBSUB_PROJECT_ID FIRESTORE_PROJECT_ID=$FIRESTORE_PROJECT_ID"
echo "  pnpm dev"
wait
