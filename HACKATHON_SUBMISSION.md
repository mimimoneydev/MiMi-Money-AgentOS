# Hackathon Submission — MiMi Money AgentOS

**Track: Fortified Enterprise Fleet · All Things Agentic Hackathon**

---

## The problem

Africa's payment rails are exploding — mobile money, USDC corridors, merchant settlement from Lagos to Nairobi to Accra — but the operational backbone is still human: fraud analysts, compliance officers, treasury clerks reconciling spreadsheets at 2 a.m. Fraud teams scale linearly with headcount; fraud scales exponentially with volume. Enterprise fleets of AI agents could close that gap, but finance can't hire autonomous agents that act like chatbots: payments demand **identity, least privilege, deterministic policy, human accountability and auditability**.

## What we built

**MiMi AgentOS — an African financial AI workforce** running on an enterprise-grade agent control plane. Ten specialized agents (Orchestrator, Payment, Fraud, Compliance, Risk, Reconciliation, Treasury, Support, Reporting, Human Escalation) operate inside departments with managers, roles, capabilities, permissions, budgets, heartbeats and lifecycle states. They process simulated USDC payments end-to-end across African corridors — and when policy says so, they stop and ask a human.

### The fortress around every action

LLM output **never** executes a privileged financial action. Every sensitive operation traverses:

```
MiMi Agent Gateway → Agent identity → RBAC/capability check → deterministic Policy Engine
  → human approval (when required) → authorized tool → result verification
  → Pub/Sub event → Firestore persistence → audit record
```

The Policy Engine is fully deterministic: fraud risk ≥ 0.85 or amount ≥ $10,000 ⇒ mandatory human review; ≥ 0.97 ⇒ auto-decline; <$1,000 low-risk ⇒ autonomous completion; sandbox-only assets/networks; rate limits; budget hard-stops.

### The two moments judges will remember

1. **$250 low-risk payment** → ten agents collaborate through Pub/Sub in seconds; workflow completes autonomously; every hop visible as a real event + Firestore document + audit record.
2. **$48,500 high-risk payment** → Fraud Agent scores 0.90 from wallet behaviour (velocity burst, counterparty novelty, 57× average amount); Policy Engine halts the workflow (`WAITING_FOR_HUMAN`), creates a real Human Review task in the control plane; operator approves; the approval event flows back through Pub/Sub and the exact same workflow resumes from persisted state and settles. Reject instead? Flow closes gracefully with full audit trail.

## How it's built

| Requirement | Delivery |
|---|---|
| Enterprise AI control plane | **Paperclip** (MIT) as foundation — org charts, approvals, activity/governance, budgets, heartbeats preserved and extended into MiMi |
| Intelligence layer | **Gemini** via ADK function-calling loops per agent (`gemini-3.6-flash`) |
| Agent framework/runtime | **Google ADK** behind one `AgentRuntimeAdapter`: `services/mimi-adk-runtime` hosts the workforce as **real `google.adk` Python LlmAgents** (Cloud Run), with in-process Gemini and deterministic local-simulation adapters for zero-cost offline mode — same runs, sessions, tool loops, pause/resume/cancel lifecycle |
| Security gateway | **MiMi Agent Gateway**: identity → RBAC → policy → approval → tool → verify, all audited |
| Async backbone | **Google Pub/Sub**: 13 topics, idempotency keys, correlation/workflow IDs, retries, timeouts, dead-letter queue, recovery |
| Memory Bank | **Firestore** (REST; emulator-compatible): agents, customers, transactions, workflows, steps, runs, events, policies, permissions, reviews, audit… never chain-of-thought |
| Infrastructure | **Cloud Run** scale-to-zero; no GKE/Cloud SQL/always-on services |

Everything is **sandbox/simulation only**, with a persistent DEMO/SANDBOX banner. Seeded world: 8 African-market customers, tuned wallet histories, historical settled/rejected transactions, an open pending review, fraud/compliance cases, treasury floats on testnets.

## Engineering quality

- **47+ tests green**: policy determinism, gateway RBAC/rate-limit/budget denials, bus idempotency/retry/DLQ/replay, Firestore REST codec, Gemini outage injection, workflow retry→escalation, duplicate-event safety, crash recovery from persisted state, reject-path closure, HTTP E2E for both demo buttons.
- Real-time UI driven by backend SSE + persisted state (no fake animations): Overview, Fleet/Organization, Agent Inspector, Workflow graph + operational trace, Transactions, Event Stream, Memory Bank inspector, Policy Center, Human Reviews, Audit, Budgets, System.
- Docs: architecture (+mermaid diagrams), security model, deployment runbook, demo script.
- Deploy scripts: IAM, Secret Manager, Firestore, Pub/Sub topics, Cloud Run — minimal surface, near-zero cost.

## Why it wins the track

It's not a mockup and not a wrapper: click a button and watch a governed agent workforce execute a real distributed workflow — with the security posture an enterprise fleet actually requires (least-privilege identities, deterministic policy, human-in-the-loop, idempotency, recovery, auditability) — all on a $0 Google stack that any African fintech team could stand up tomorrow.

> **Paperclip/MiMi AgentOS = the enterprise control plane · Gemini + Google ADK = intelligence & runtime · MiMi Agent Gateway = security/governance · Pub/Sub = the nervous system · Firestore = memory/state · Cloud Run = execution · MiMi agents = the workforce.**
