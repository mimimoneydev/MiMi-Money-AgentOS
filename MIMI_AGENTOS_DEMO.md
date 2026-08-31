# MiMi AgentOS — Demo Script

> Four-minute judge walkthrough. Everything below runs against the real backend — no mockups.

## 0. Start the system (30 seconds, one command)

```sh
pnpm install
pnpm dev
```

Open **http://localhost:3100** → log in (first run creates an admin) → the sidebar shows the **MiMi AgentOS** section with a persistent `DEMO · SANDBOX` banner. No API keys required: without `MIMI_GEMINI_API_KEY`, agents run in ADK local-simulation mode (identical pipeline, deterministic reasoning). Add the key to watch Gemini drive the same tool loops live.

## 1. The workforce (0:00–0:40)

1. **Overview** (`/mimi`) — live counters straight from backend state: 10 agents healthy, running workflows, pending reviews, 24h volume, fraud/compliance alerts, event throughput.
2. **Agent Fleet** (`/mimi/fleet`) — the financial AI org chart: Orchestrator on top; Payments, Risk & Fraud, Compliance, Treasury, Customer Experience departments; live status badges and heartbeats.
3. **Organization** (`/mimi/organization`) — missions and reporting lines.
4. Click any agent → **Inspector**: role, department, manager, capabilities, permissions (gateway tool grants), memory scope, runtime (`google-adk`, model), Cloud Run service name, heartbeat, success rate, budget bar, recent ADK runs with tool calls.

Talking point: *"This is MiMi Money AgentOS: an African financial AI workforce with its own governed org chart, budgets, approvals and audit trail. It uses Paperclip as the underlying control-plane framework."*

## 2. $250 low-risk payment (0:40–1:30)

1. On **Overview**, press **SIMULATE $250 LOW-RISK PAYMENT**.
2. Open **Workflows** (`/mimi/workflows`) → click the new workflow.
3. Watch the graph light up from REAL persisted state:
   `payment.received → Payment Agent → Fraud ∥ Compliance → Risk → Policy Gate ALLOWED → Treasury → Reconciliation → Completion → Support ∥ Reporting`.
4. **Events** (`/mimi/events`) — the Pub/Sub feed shows every envelope: `payment.validated`, `fraud.analysis-completed`, `compliance.evaluated`, `risk.gate-decision`, `treasury.settlement-plan`, `reconciliation.completed`, `workflow.completed` — each with workflow ID + correlation ID + idempotency key.
5. **Memory Bank** (`/mimi/memory-bank`) — browse `workflows`, `agent_runs`, `transactions`: Firestore-shaped documents with step artifacts (fraud score ≈0.24, compliance CLEAR, balanced ledger legs).
6. **Transactions** (`/mimi/transactions`) — the $250 settled; **Audit** (`/mimi/audit`) — every gateway execution recorded.

## 3. $48,500 high-risk payment + human-in-the-loop (1:30–3:00) ★

1. Press **SIMULATE $48,500 HIGH-RISK PAYMENT** (merchant "Chidi Okafor Freight", Kano).
2. Workflow graph: Fraud Agent scores **0.90** (velocity + counterparty novelty + 57× average amount). Policy Gate flips to **REQUIRE_HUMAN_APPROVAL** — two rules matched: `pol-fraud-high-review`, `pol-human-above-10k`. Status: **WAITING_FOR_HUMAN**. Downstream steps stay idle — *this is backend state, not animation*.
3. Sidebar badge counts up. Open **Human Reviews** (`/mimi/human-reviews`): a real review task with amount, customer, fraud score, compliance result, matched policy IDs and reason.
4. Click **Approve & resume workflow**.
5. **Events**: `human-review.requested` → `human-review.approved` → treasury/reconciliation/support/reporting events resume → `workflow.completed`. The workflow graph finishes green; transaction COMPLETED.
6. Optional flourish: trigger another high-risk payment and press **Reject** — flow closes gracefully, transaction REJECTED, support/reporting still produce the audit trail.

Talking point: *"Gemini/ADK agents did all the analysis, but a deterministic Policy Engine decided that this payment cannot complete autonomously. The human decision flows back through Pub/Sub and the exact same workflow resumes from persisted state."*

## 4. Resilience proof points (3:00–3:30, optional but impressive)

- **Duplicate safety:** `curl -X POST /api/mimi/demo/payment/low -H 'Content-Type: application/json' -d '{"idempotencyKey":"judge-1"}'` twice — second call returns the SAME workflow, `duplicated: true`; bus stats show duplicates suppressed (**System** page).
- **Crash recovery:** kill `pnpm dev` mid-workflow, start again — `recoverInFlight()` re-drives it from the Memory Bank (or press **Run recovery pass** on **System**).
- **Policy center:** toggle rules live on **Policies**; budgets with hard stops on **Budgets**.
- **Gateway contract (the fortress, on the wire):**
  ```sh
  # deterministic dry-run decision — never executes:
  curl -s -X POST localhost:3100/api/mimi/gateway/authorize \
    -H 'Content-Type: application/json' \
    -d '{"agentId":"orchestrator","toolName":"settle-payment","amountUsd":48500}' | jq .decision
  # RBAC denial — support-agent cannot touch reconciliation tools:
  curl -s -X POST localhost:3100/api/mimi/gateway/tool-call \
    -H 'Content-Type: application/json' \
    -d '{"agentId":"support-agent","toolName":"reconcile_transaction","args":{"transactionId":"x"}}' | jq
  # cross-line delegation is refused (403) — reporting lines are enforced:
  curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3100/api/mimi/gateway/agent-call \
    -H 'Content-Type: application/json' \
    -d '{"fromAgentId":"support-agent","toAgentId":"reconciliation-agent","instruction":"nope"}'
  ```
  Also available: `GET /api/mimi/gateway/policies` and `GET /api/mimi/gateway/permissions` (the full 10×12 permission matrix).

## 5. Google Cloud proof (3:30–4:00)

1. **System** (`/mimi/system`) — the stack panel names each layer: control plane, Gemini model + mode, ADK adapter, Gateway pipeline stages, Memory Bank mode, Pub/Sub project/topics, DLQ.
2. Show the emulator wiring (optional): `PUBSUB_EMULATOR_HOST=localhost:8085 FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 ./deploy/local-emulators.sh` then restart `pnpm dev` — **System** now reports `google-pubsub-emulator` + `firestore-emulator`, and events/documents are mirrored into real Google APIs locally.
3. If deployed: open Cloud Run console → `mimi-agentos` service (scale-to-zero), Pub/Sub topics list, Firestore collections. Architecture diagram: `MIMI_AGENTOS_ARCHITECTURE.md`.

## One-line summary for judges

> **MiMi Money AgentOS = the enterprise financial control plane; Gemini + Google ADK = the intelligence and runtime; MiMi Agent Gateway = security/governance; Pub/Sub = the nervous system; Firestore = persistent memory/state; Cloud Run = execution/deployment; MiMi's ten agents = the autonomous African financial workforce. Paperclip is the underlying framework.**
