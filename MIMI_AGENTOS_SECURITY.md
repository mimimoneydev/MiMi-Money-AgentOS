# MiMi AgentOS — Security Model

> **DEMO / SANDBOX MODE.** Every financial operation in MiMi AgentOS is a simulation against sandbox/test data. There is no code path — and no configuration — that can move real money.

## 1. Threat model (what we defend against)

1. **Prompt-injected / hallucinating agents executing privileged actions.** An LLM (or its attacker) invents a tool call, an amount, or a "customer approved" claim.
2. **Over-privileged agents.** A compromised agent tries tools outside its mandate.
3. **Runaway autonomy.** High-value or high-risk payments completing without human judgment.
4. **Replay / duplicate processing.** The same payment event processed twice.
5. **Cost runaway.** An agent burning unlimited model spend.
6. **Secret leakage.** Credentials reaching prompts, logs, memory or the browser.
7. **Unauditable actions.** Regulators/judges asking "who did what, when, and why was it allowed?"

## 2. Core invariant

> **LLM output never executes privileged financial actions directly.**

Gemini can only emit *requests* (function calls). Execution happens exclusively inside the **MiMi Agent Gateway**:

```
identity → RBAC/capability check → deterministic Policy Engine
  → human approval (when required) → authorized tool → result verification
  → Pub/Sub event → Firestore persistence → audit record
```

Every stage can refuse. Refusals are audited with the matched rule IDs.

## 3. Control inventory

| Control | Implementation | Where |
|---|---|---|
| Agent identity | Agents resolved from the Memory Bank registry; unknown identities are denied before anything else runs | `gateway.ts` step 1 |
| RBAC / least privilege | Per-agent tool allowlists (`agent.permissions`); the Gateway refuses any tool not granted even if policy would allow it; Gemini tool declarations are filtered to the agent's grants | `constants.ts`, `gateway.geminiToolDeclarationsFor` |
| Deterministic Policy Engine | Ordered seeded rules: sandbox-only assets/networks, fraud bands (≥0.85 review, ≥0.97 decline), sanctions block, ≥$10k human approval, low-risk auto-approve band | `policy-engine.ts`, `policies` collection |
| Human approval gate | `REQUIRE_HUMAN_APPROVAL` creates a real Human Review task; workflow persists as `WAITING_FOR_HUMAN`; settlement cannot proceed until an operator approves through the UI/API; decisions flow back over Pub/Sub | `orchestrator.ts` |
| Tool authorization & capability classes | Each tool declares `read`/`write`/`privileged`; workflow-scoped tools (`request_human_approval`) reject direct invocation | `tools.ts` |
| Result verification | Post-execution sanity checks (defined results, non-negative amounts) before persistence | `gateway.verifyResult` |
| Rate limiting | Sliding 60-second window per `(agent, tool)`; excess calls denied + audited | `gateway.ts` |
| Idempotency | Bus-level duplicate suppression by `idempotencyKey`; workflow-level dedup by source event key; review double-decisions return 409 | `event-bus.ts`, `orchestrator.ts` |
| Budget hard stop | Monthly per-agent caps inherited from Paperclip's cost governance; at cap the agent is PAUSED and invocations denied until reset | `service.resetBudget`, policy `pol-budget-hard-stop` |
| Audit logging | Every gateway decision, workflow escalation, review decision, and lifecycle transition written to the `audit` collection AND mirrored into Paperclip's activity log for board-level governance | `gateway.writeAudit`, `server/routes/mimi.ts` |
| Secret isolation | Gemini API keys resolve from env vars locally and Secret Manager on Cloud Run; keys are injected only into the runtime adapter — they are never placed in prompts, agent instructions, tool payloads, Memory Bank documents, audit records or API responses. Agents have no credential material at all; capability is mediated by the Gateway. | `adk-gemini-runtime.ts`, `deploy/setup-secrets.sh` |
| Sandbox guard | Structural deny rule for any non-sandbox asset/network; treasury accounts, wallets and ledger legs are simulated records; every transaction row carries `sandbox: true`; the UI displays a persistent DEMO/SANDBOX banner | `policy-engine.ts`, `seed.ts`, UI shell |

## 4. Chain-of-thought hygiene

Prompts explicitly instruct agents to state conclusions and evidence pointers only. The runtime persists session events of kinds: user message, model tool call, tool response, final text, system notes. No hidden reasoning is requested, stored, or exposed by the API — the operational trace shown in the UI contains safe audit events ("fraud analysis completed", "approval requested", "workflow resumed").

## 5. Data protection

- Firestore in production uses project-level IAM; the instance identity needs only the Firestore user role on one database.
- Pub/Sub topics are project-scoped; publishers/subscribers are the single Cloud Run service account.
- Customer PII in the demo is fictional seed data. In production deployments the Memory Bank lives entirely inside the operator's own GCP project (data residency under operator control); Paperclip telemetry remains opt-out per upstream defaults.
- The control plane inherits Paperclip auth: local dev runs in `local_trusted` loopback mode; deployed instances sit behind Cloud Run IAM / your SSO choice. MiMi endpoints run inside the same authenticated `/api` surface and never bypass actor checks.

## 6. Failure containment

- Handler timeouts + bounded retries + dead-letter queue prevent poison messages from blocking workflows.
- Startup recovery re-drives interrupted workflows from persisted state; completed steps are never re-executed.
- Permanent failures escalate (`ESCALATED`) and open ops cases instead of silently retrying forever.
- Simulated-failure test hooks exist to prove these paths (`failNextPerAgent`, injected Gemini outages) — see the recovery/retry tests in `packages/mimi/src/orchestrator.test.ts`.

## 7. What this demo deliberately does NOT do

- No real custody, no key management for on-chain wallets, no bank rails. Treasury "balances" and ledger legs are simulated rows.
- No production-grade KYC vendor integration; compliance screening uses a seeded sandbox sanctions list plus deterministic KYC-tier rules.
- No multi-tenant hardening beyond Paperclip's company scoping (the demo operates a single sandbox company).

These boundaries are exactly what makes the system safe to demo: the blast radius of every bug is zero.
