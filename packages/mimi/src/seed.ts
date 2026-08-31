import type {
  AdkAdapterMode,
  HumanReview,
  MimiAgent,
  MimiCase,
  MimiWorkflow,
  MimiCustomer,
  MimiEvent,
  MimiNotification,
  MimiReport,
  MimiTransaction,
  MimiWalletHistory,
  WalletEntry,
} from "./types.js";
import {
  buildDefaultAgents,
  buildDefaultPolicies,
  DEFAULT_GEMINI_MODEL,
} from "./constants.js";
import type { MemoryBank } from "./types.js";

/**
 * Realistic sandbox seed data for demos and tests: African-market customers,
 * wallet histories tuned so that a $250 payment scores LOW fraud risk while a
 * $48,500 payment by the merchant account scores ≥0.85 (mandatory human
 * review), completed historical workflows, an open human review, cases and
 * treasury floats.
 */

const H = 3600_000;
const MIN = 60_000;

interface CustomerSeedSpec {
  id: string;
  name: string;
  country: string;
  market: string;
  kycTier: MimiCustomer["kycTier"];
  riskSegment: MimiCustomer["riskSegment"];
  notes?: string;
}

const CUSTOMER_SPECS: CustomerSeedSpec[] = [
  { id: "cus_amara", name: "Amara Okonkwo", country: "Nigeria", market: "Lagos", kycTier: "full", riskSegment: "retail" },
  { id: "cus_chidi", name: "Chidi Okafor Freight", country: "Nigeria", market: "Kano", kycTier: "intermediate", riskSegment: "merchant", notes: "High-volume freight merchant; watch velocity." },
  { id: "cus_wanjiru", name: "Wanjiru Kamau", country: "Kenya", market: "Nairobi", kycTier: "full", riskSegment: "business" },
  { id: "cus_kwame", name: "Kwame Mensah", country: "Ghana", market: "Accra", kycTier: "intermediate", riskSegment: "retail" },
  { id: "cus_aminata", name: "Aminata Diallo Textiles", country: "Senegal", market: "Dakar", kycTier: "full", riskSegment: "merchant" },
  { id: "cus_tendai", name: "Tendai Moyo", country: "South Africa", market: "Johannesburg", kycTier: "intermediate", riskSegment: "retail" },
  { id: "cus_femi", name: "Femi Adeyemi", country: "Nigeria", market: "Ibadan", kycTier: "basic", riskSegment: "retail" },
  { id: "cus_grady", name: "Grady Transit Logistics", country: "Unlisted", market: "Unknown", kycTier: "basic", riskSegment: "business", notes: "SANCTIONS LIST MATCH — onboarded then blocked." },
];

function walletFor(spec: CustomerSeedSpec, nowMs: number): MimiWalletHistory {
  const entry = (
    i: number,
    direction: WalletEntry["direction"],
    amountUsd: number,
    agoMs: number,
    counterparty: string,
  ): WalletEntry => ({
    id: `${spec.id}_w${i}`,
    customerId: spec.id,
    direction,
    asset: "USDC",
    network: spec.riskSegment === "merchant" ? "polygon-amoy" : "base-sepolia",
    amountUsd,
    occurredAt: new Date(nowMs - agoMs).toISOString(),
    counterparty,
    txHash: `0x${(BigInt(i) * 0x9e3779b97f4a7n ^ BigInt(spec.id.length)).toString(16).padStart(12, "0")}`,
  });

  switch (spec.id) {
    // LOW-RISK DEMO CUSTOMER — $250 must stay well under the review band.
    case "cus_amara":
      return {
        customerId: spec.id,
        avgAmountUsd: 420,
        maxAmountUsd: 900,
        volume30dUsd: 12600,
        entries: [
          entry(1, "debit", 380, 26 * H, "Shoprite Ikeja"),
          entry(2, "credit", 450, 3 * 24 * H, "Payroll — Lumina Studios"),
          entry(3, "debit", 120, 20 * MIN, "MTN Nigeria airtime"),
        ],
      };
    // HIGH-RISK DEMO CUSTOMER — $48,500 must score ≥0.85 fraud risk.
    case "cus_chidi":
      return {
        customerId: spec.id,
        avgAmountUsd: 850,
        maxAmountUsd: 2400,
        volume30dUsd: 41200,
        entries: [
          entry(1, "credit", 2100, 80 * MIN, "0x51f…a3 (new)"),
          entry(2, "credit", 1900, 70 * MIN, "0x8bc…09 (new)"),
          entry(3, "credit", 2600, 55 * MIN, "0xf02…7d (new)"),
          entry(4, "credit", 1400, 40 * MIN, "0x77a…41 (new)"),
          entry(5, "credit", 3100, 28 * MIN, "0xe99…c2 (new)"),
          entry(6, "credit", 1750, 12 * MIN, "0x3dd…58 (new)"),
          entry(7, "credit", 2400, 4 * 24 * H, "Kano Traders Co-op"),
          entry(8, "credit", 1600, 9 * 24 * H, "Lagos Port Haulage"),
        ],
      };
    default:
      return {
        customerId: spec.id,
        avgAmountUsd: 300 + (spec.id.length * 17) % 400,
        maxAmountUsd: 1500,
        volume30dUsd: 8000 + (spec.id.length * 1300),
        entries: [
          entry(1, "debit", 220, 30 * H, "Utility provider"),
          entry(2, "credit", 540, 2 * 24 * H, "Marketplace payout"),
          entry(3, "debit", 180, 3 * 24 * H, "Groceries"),
        ],
      };
  }
}

export async function seedMemoryBank(memoryBank: MemoryBank, opts: { runtimeMode: AdkAdapterMode; model?: string } = { runtimeMode: "local-simulation" }): Promise<void> {
  const nowMs = Date.now();
  const iso = (agoMs = 0) => new Date(nowMs - agoMs).toISOString();
  const model = opts.model ?? DEFAULT_GEMINI_MODEL;

  // Agents ---------------------------------------------------------------
  for (const agent of buildDefaultAgents(model)) {
    const existing = await memoryBank.get<MimiAgent>("agents", agent.id);
    if (!existing) {
      agent.runtime.mode = opts.runtimeMode;
      await memoryBank.put("agents", agent as unknown as Record<string, unknown> & { id: string });
    }
  }

  // Policies ---------------------------------------------------------------
  for (const rule of buildDefaultPolicies()) {
    if (!(await memoryBank.get("policies", rule.id))) {
      await memoryBank.put("policies", rule as unknown as Record<string, unknown> & { id: string });
    }
  }

  // Customers + wallets ----------------------------------------------------
  for (const spec of CUSTOMER_SPECS) {
    if (!(await memoryBank.get<MimiCustomer>("customers", spec.id))) {
      const customer: MimiCustomer = {
        id: spec.id,
        name: spec.name,
        country: spec.country,
        market: spec.market,
        kycTier: spec.kycTier,
        riskSegment: spec.riskSegment,
        walletAddress: `0x${spec.id.replace("cus_", "").padEnd(6, "0")}${Math.floor(nowMs / 1000).toString(16)}fe`,
        walletNetwork: spec.riskSegment === "merchant" ? "polygon-amoy" : "base-sepolia",
        createdAt: iso(45 * 24 * H),
        notes: spec.notes,
      };
      await memoryBank.put("customers", customer as unknown as Record<string, unknown> & { id: string });
      await memoryBank.put("wallets", { ...walletFor(spec, nowMs), id: spec.id });
    }
  }

  // Demo-critical wallets are RE-ANCHORED on every boot so their velocity /
  // recency signals stay valid no matter how long the instance has been up
  // (the $48,500 demo must always score fraud risk ≥ 0.85).
  for (const demoSpec of CUSTOMER_SPECS.filter((s) => s.id === "cus_amara" || s.id === "cus_chidi")) {
    await memoryBank.put("wallets", { ...walletFor(demoSpec, nowMs), id: demoSpec.id });
  }

  // Permissions / authorization metadata -----------------------------------
  const permSeeds: Array<Record<string, unknown>> = [
    {
      id: "perm_sanctions_ofac_sandbox",
      kind: "sanctions-entry",
      listName: "OFAC-SDN-SANDBOX",
      matchValue: "GRADY TRANSIT LOGISTICS",
      description: "Sandbox sanctions test record.",
    },
    {
      id: "perm_sanctions_eu_deadbeef",
      kind: "sanctions-entry",
      listName: "EU-SANDBOX",
      matchValue: "0xdeadbeef0000000000000000000000000000dead",
      description: "Sandbox sanctioned wallet address.",
    },
    {
      id: "perm_network_allowlist",
      kind: "network-allowlist",
      networks: ["base-sepolia", "polygon-amoy", "arbitrum-sepolia", "celo-alfajores", "internal-sandbox"],
      assets: ["USDC", "USDT", "cUSD"],
      description: "Only sandbox/testnet networks and stablecoin test assets may be referenced.",
    },
    {
      id: "perm_secret_isolation",
      kind: "policy-note",
      note: "Gemini API keys resolve from env vars locally and Secret Manager on Cloud Run; agents never receive raw credentials — the Gateway injects capability.",
    },
  ];
  for (const p of permSeeds) {
    if (!(await memoryBank.get("permissions", p.id as string))) {
      await memoryBank.put("permissions", p as Record<string, unknown> & { id: string });
    }
  }

  // Treasury -----------------------------------------------------------------
  const treasuries = [
    { id: "trs_base_sepolia", label: "MiMi Float — Base Sepolia", network: "base-sepolia", asset: "USDC", balanceUsd: 250_000, bufferUsd: 50_000 },
    { id: "trs_polygon_amoy", label: "MiMi Float — Polygon Amoy", network: "polygon-amoy", asset: "USDC", balanceUsd: 180_000, bufferUsd: 40_000 },
    { id: "trs_internal", label: "MiMi Internal Sandbox Ledger", network: "internal-sandbox", asset: "USDC", balanceUsd: 1_000_000, bufferUsd: 100_000 },
    { id: "trs_celo_alfajores", label: "MiMi Float — Celo Alfajores", network: "celo-alfajores", asset: "cUSD", balanceUsd: 95_000, bufferUsd: 20_000 },
  ];
  for (const t of treasuries) {
    if (!(await memoryBank.get("treasury_accounts", t.id))) {
      await memoryBank.put("treasury_accounts", { ...t, createdAt: iso() } as Record<string, unknown> & { id: string });
    }
  }

  // Historical transactions + completed workflows ----------------------------
  if (!(await memoryBank.get<MimiTransaction>("transactions", "txn_hist_001"))) {
    const hist: Array<{ tx: Partial<MimiTransaction> & { id: string; customerId: string; amountUsd: number }; outcome: "SETTLED" | "REJECTED_SANCTIONS" }> = [
      { tx: { id: "txn_hist_001", customerId: "cus_wanjiru", amountUsd: 145, memo: "Supplier invoice #4471" }, outcome: "SETTLED" },
      { tx: { id: "txn_hist_002", customerId: "cus_kwame", amountUsd: 89.5, memo: "Airtime bundle" }, outcome: "SETTLED" },
      { tx: { id: "txn_hist_003", customerId: "cus_aminata", amountUsd: 640, memo: "Fabric order settlement" }, outcome: "SETTLED" },
      { tx: { id: "txn_hist_004", customerId: "cus_grady", amountUsd: 12500, memo: "Transit logistics invoice — SANCTIONS MATCH" }, outcome: "REJECTED_SANCTIONS" },
      { tx: { id: "txn_hist_005", customerId: "cus_tendai", amountUsd: 310, memo: "Consulting retainer" }, outcome: "SETTLED" },
      { tx: { id: "txn_hist_006", customerId: "cus_femi", amountUsd: 42, memo: "Data bundle" }, outcome: "SETTLED" },
      { tx: { id: "txn_hist_007", customerId: "cus_amara", amountUsd: 760, memo: "Rent share" }, outcome: "SETTLED" },
    ];
    for (const [i, h] of hist.entries()) {
      const createdAgo = (i + 2) * 7 * H;
      const blocked = h.outcome === "REJECTED_SANCTIONS";
      const tx: MimiTransaction = {
        id: h.tx.id,
        reference: `MIMI-HIST-${String(i + 1).padStart(3, "0")}`,
        customerId: h.tx.customerId,
        amountUsd: h.tx.amountUsd,
        asset: "USDC",
        network: "base-sepolia",
        direction: "inbound",
        status: blocked ? "REJECTED" : "COMPLETED",
        fraudRiskScore: blocked ? 0.22 : Math.min(0.35, h.tx.amountUsd / 5000),
        complianceResult: blocked ? "BLOCKED" : "CLEAR",
        riskScore: blocked ? 0.71 : Math.min(0.4, h.tx.amountUsd / 6000),
        workflowId: `wf_${h.tx.id}`,
        memo: h.tx.memo ?? "",
        createdAt: iso(createdAgo),
        completedAt: iso(createdAgo - 6 * MIN),
        sandbox: true,
      };
      await memoryBank.put("transactions", tx as unknown as Record<string, unknown> & { id: string });
      await memoryBank.put("workflows", makeCompletedWorkflow(tx, blocked ? "REJECTED_SANCTIONS" : "SETTLED", iso(createdAgo)) as unknown as Record<string, unknown> & { id: string });
    }

    // Pending human review seeded BEFORE the demo ---------------------------
    const pendingTx: MimiTransaction = {
      id: "txn_hist_pending",
      reference: "MIMI-HIST-PENDING",
      customerId: "cus_chidi",
      amountUsd: 32800,
      asset: "USDC",
      network: "polygon-amoy",
      direction: "inbound",
      status: "WAITING_FOR_HUMAN",
      fraudRiskScore: 0.88,
      complianceResult: "CLEAR",
      riskScore: 0.66,
      workflowId: "wf_hist_pending",
      memo: "Overnight clearing batch — flagged by fraud band",
      createdAt: iso(52 * MIN),
      completedAt: null,
      sandbox: true,
    };
    await memoryBank.put("transactions", pendingTx as unknown as Record<string, unknown> & { id: string });
    const pendingWf = makeWaitingWorkflow(pendingTx, iso(52 * MIN));
    await memoryBank.put("workflows", pendingWf as unknown as Record<string, unknown> & { id: string });
    const pendingReview: HumanReview = {
      id: "rev_hist_pending",
      workflowId: "wf_hist_pending",
      transactionId: "txn_hist_pending",
      requestedByAgent: "escalation-agent",
      amountUsd: 32800,
      asset: "USDC",
      customerId: "cus_chidi",
      fraudRiskScore: 0.88,
      complianceResult: "CLEAR",
      reason: "$32,800 ≥ human-approval threshold $10,000; fraud risk 0.88 ≥ 0.85 → mandatory human review",
      policyRuleIds: ["pol-human-above-10k", "pol-fraud-high-review"],
      status: "PENDING",
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      expiresAt: new Date(nowMs + 24 * H).toISOString(),
      createdAt: iso(50 * MIN),
      sandbox: true,
    };
    await memoryBank.put("human_reviews", pendingReview as unknown as Record<string, unknown> & { id: string });
  }

  // Cases ---------------------------------------------------------------------
  if (!(await memoryBank.get<MimiCase>("cases", "case_seed_compliance"))) {
    await memoryBank.put("cases", {
      id: "case_seed_compliance",
      kind: "compliance",
      title: "Sanctions match — Grady Transit Logistics",
      status: "RESOLVED",
      severity: "high",
      openedByAgent: "compliance-agent",
      relatedTransactionId: "txn_hist_004",
      relatedCustomerId: "cus_grady",
      summary: "Name matched OFAC-SDN-SANDBOX during screening; payment rejected autonomously by policy pol-sanctions-block; entity frozen pending manual offboarding.",
      createdAt: iso(14 * H),
      resolvedAt: iso(9 * H),
    } as unknown as Record<string, unknown> & { id: string });
    await memoryBank.put("cases", {
      id: "case_seed_fraud",
      kind: "fraud",
      title: "Velocity anomaly — Chidi Okafor Freight",
      status: "IN_REVIEW",
      severity: "high",
      openedByAgent: "fraud-agent",
      relatedTransactionId: "txn_hist_pending",
      relatedCustomerId: "cus_chidi",
      summary: "Six inbound credits from previously unseen counterparties within 90 minutes; pattern consistent with layered structuring. Escalated to Human Review.",
      createdAt: iso(49 * MIN),
      resolvedAt: null,
    } as unknown as Record<string, unknown> & { id: string });
  }

  // Notifications ---------------------------------------------------------------
  if (!(await memoryBank.get<MimiNotification>("notifications", "ntf_seed_001"))) {
    await memoryBank.put("notifications", {
      id: "ntf_seed_001",
      channel: "in-app",
      recipient: "operator",
      subject: "Human Review waiting: $32,800 USDC",
      body: "Fraud Agent flagged overnight batch txn_hist_pending. Policy requires operator decision before settlement.",
      severity: "warning",
      workflowId: "wf_hist_pending",
      createdAt: iso(50 * MIN),
      read: false,
    } as unknown as Record<string, unknown> & { id: string });
    await memoryBank.put("notifications", {
      id: "ntf_seed_002",
      channel: "in-app",
      recipient: "cus_amara",
      subject: "Payment completed",
      body: "Your sandbox payment settled in 4.2s via MiMi Money AgentOS.",
      severity: "info",
      workflowId: null,
      createdAt: iso(26 * H),
      read: true,
    } as unknown as Record<string, unknown> & { id: string });
  }

  // Reports ----------------------------------------------------------------------
  if (!(await memoryBank.get<MimiReport>("reports", "rpt_seed_001"))) {
    await memoryBank.put("reports", {
      id: "rpt_seed_001",
      workflowId: "wf_txn_hist_001",
      transactionId: "txn_hist_001",
      title: "Workflow report — txn_hist_001",
      bodyMarkdown: "# Workflow report\n\nAutonomous low-risk settlement completed by the MiMi workforce.\n\n- Fraud 0.09 · Compliance CLEAR · Risk 0.21\n- Reconciliation balanced (2 legs)\n- All actions Gateway-audited; sandbox only.",
      generatedByAgent: "reporting-agent",
      createdAt: iso(6 * H),
    } as unknown as Record<string, unknown> & { id: string });
  }

  // A few historical agent events so the Event Stream has context ---------------
  const seedEvents: Array<Pick<MimiEvent, "topic" | "type"> & { agoMs: number; source: MimiEvent["sourceAgent"] }> = [
    { topic: "mimi.lifecycle", type: "agent.heartbeat", agoMs: 18 * MIN, source: "orchestrator" },
    { topic: "mimi.compliance", type: "compliance.blocked", agoMs: 14 * MIN, source: "compliance-agent" },
    { topic: "mimi.audit", type: "gateway.decision", agoMs: 14 * MIN, source: "system" },
    { topic: "mimi.human-review", type: "human-review.requested", agoMs: 50 * MIN, source: "escalation-agent" },
    { topic: "mimi.fraud", type: "fraud.analysis-completed", agoMs: 51 * MIN, source: "fraud-agent" },
    { topic: "mimi.payments", type: "payment.validated", agoMs: 52 * MIN, source: "payment-agent" },
  ];
  for (const [i, e] of seedEvents.entries()) {
    const id = `evt_seed_${String(i + 1).padStart(3, "0")}`;
    if (!(await memoryBank.get("agent_events", id))) {
      await memoryBank.put("agent_events", {
        id,
        eventId: id,
        topic: e.topic,
        type: e.type,
        workflowId: e.type === "human-review.requested" ? "wf_hist_pending" : null,
        correlationId: "seed-correlation",
        idempotencyKey: `seed:${id}`,
        occurredAt: iso(e.agoMs),
        sourceAgent: e.source,
        targetAgent: null,
        payload: { seeded: true },
        attempt: 1,
      } as unknown as Record<string, unknown> & { id: string });
    }
  }
}

function makeCompletedWorkflow(tx: MimiTransaction, outcome: "SETTLED" | "REJECTED_SANCTIONS", createdIso: string): MimiWorkflow {
  const done = (key: string, label: string, agentId: MimiWorkflow["steps"][number]["agentId"], order: number, deps: string[], summary: string, artifacts: Record<string, unknown>): WorkflowStepLike => ({
    id: `${tx.id}_step_${key}`,
    key,
    label,
    agentId,
    status: key === "gate" && outcome === "REJECTED_SANCTIONS" ? "COMPLETED" : "COMPLETED",
    dependsOn: deps,
    startedAt: createdIso,
    completedAt: createdIso,
    attempt: 1,
    maxAttempts: 3,
    outputSummary: summary,
    artifacts,
    runId: `run_${tx.id}_${key}`.slice(0, 24),
    error: null,
    order,
  });
  const steps: WorkflowStepLike[] = [
    done("validate", "Validate & initiate", "payment-agent", 0, [], "Validated instruction.", {}),
    done("fraud", "Fraud analysis", "fraud-agent", 1, ["validate"], "Fraud analysis completed.", { fraudRiskScore: tx.fraudRiskScore ?? 0.1 }),
    done("compliance", "Compliance screening", "compliance-agent", 2, ["validate"], outcome === "REJECTED_SANCTIONS" ? "BLOCKED — sanctions hit" : "CLEAR.", { complianceResult: tx.complianceResult ?? "CLEAR" }),
    done("risk", "Composite risk evaluation", "risk-agent", 3, ["fraud", "compliance"], "Risk calculated.", { riskScore: tx.riskScore ?? 0.2 }),
    done("gate", "Policy gate / human approval", "orchestrator", 4, ["risk"], outcome === "REJECTED_SANCTIONS" ? "DENIED: sanctions/compliance block" : "ALLOWED autonomous processing.", { gateDecision: outcome === "REJECTED_SANCTIONS" ? "DENY" : "ALLOW" }),
    done("settlement-plan", "Treasury settlement plan", "treasury-agent", 5, ["gate"], "Settlement planned (sandbox).", {}),
    done("reconciliation", "Ledger reconciliation", "reconciliation-agent", 6, ["settlement-plan"], "Reconciliation completed; balanced.", { balanced: true }),
    done("completion", "Complete & settle (sandbox)", "orchestrator", 7, ["reconciliation"], outcome === "REJECTED_SANCTIONS" ? "Closed without settlement." : "Payment settled in sandbox.", {}),
    done("support-followup", "Customer follow-up", "support-agent", 8, ["completion"], "Notification dispatched.", {}),
    done("reporting", "Audit report", "reporting-agent", 9, ["completion"], "Report generated.", {}),
  ];
  return {
    id: `wf_${tx.id}`,
    kind: "payment",
    transactionId: tx.id,
    status: outcome === "REJECTED_SANCTIONS" ? "ESCALATED" : "COMPLETED",
    currentStepKeys: [],
    steps: steps as unknown as MimiWorkflow["steps"],
    trace: [
      { at: createdIso, level: "info", actor: "system", message: `Payment received: $${tx.amountUsd.toFixed(2)} ${tx.asset}` },
      ...(outcome === "REJECTED_SANCTIONS"
        ? [{ at: createdIso, level: "error" as const, actor: "orchestrator" as const, message: "Auto-declined by policy: sanctions/hard AML hit" }]
        : [{ at: createdIso, level: "info" as const, actor: "orchestrator" as const, message: "Reconciliation completed; payment settled in sandbox." }]),
    ],
    sourceEventIdempotencyKey: `seed:${tx.id}`,
    humanReviewId: null,
    policyDecision: {
      decision: outcome === "REJECTED_SANCTIONS" ? "DENY" : "ALLOW",
      matchedRules: [],
      reasons: ["seeded historical decision"],
      evaluatedAt: createdIso,
      engine: "deterministic-v1",
    },
    error: null,
    createdAt: createdIso,
    updatedAt: createdIso,
    completedAt: createdIso,
    sandbox: true,
  };
}

function makeWaitingWorkflow(tx: MimiTransaction, createdIso: string): MimiWorkflow {
  const step = (key: string, label: string, agentId: string, order: number, deps: string[], status: string, summary: string | null, artifacts: Record<string, unknown>): WorkflowStepLike => ({
    id: `${tx.id}_step_${key}`,
    key,
    label,
    agentId: agentId as WorkflowStepLike["agentId"],
    status: status as WorkflowStepLike["status"],
    dependsOn: deps,
    startedAt: status === "WAITING" ? createdIso : null,
    completedAt: null,
    attempt: 1,
    maxAttempts: 3,
    outputSummary: summary,
    artifacts,
    runId: null,
    error: null,
    order,
  });
  return {
    id: `wf_${tx.id}`,
    kind: "payment",
    transactionId: tx.id,
    status: "WAITING_FOR_HUMAN",
    currentStepKeys: ["gate"],
    steps: [
      step("validate", "Validate & initiate", "payment-agent", 0, [], "COMPLETED", "Validated inbound instruction.", {}),
      step("fraud", "Fraud analysis", "fraud-agent", 1, ["validate"], "COMPLETED", "Fraud analysis completed: risk 0.88.", { fraudRiskScore: 0.88 }),
      step("compliance", "Compliance screening", "compliance-agent", 2, ["validate"], "COMPLETED", "Compliance evaluated: CLEAR.", { complianceResult: "CLEAR" }),
      step("risk", "Composite risk evaluation", "risk-agent", 3, ["fraud", "compliance"], "COMPLETED", "Composite risk 0.66 (high).", { riskScore: 0.66 }),
      step("gate", "Policy gate / human approval", "orchestrator", 4, ["risk"], "WAITING", "Human approval required.", { gateDecision: "REQUIRE_HUMAN_APPROVAL", fraudRiskScore: 0.88 }),
      step("settlement-plan", "Treasury settlement plan", "treasury-agent", 5, ["gate"], "IDLE", null, {}),
      step("reconciliation", "Ledger reconciliation", "reconciliation-agent", 6, ["settlement-plan"], "IDLE", null, {}),
      step("completion", "Complete & settle (sandbox)", "orchestrator", 7, ["reconciliation"], "IDLE", null, {}),
      step("support-followup", "Customer follow-up", "support-agent", 8, ["completion"], "IDLE", null, {}),
      step("reporting", "Audit report", "reporting-agent", 9, ["completion"], "IDLE", null, {}),
    ],
    trace: [
      { at: createdIso, level: "info", actor: "system", message: `Payment received: $${tx.amountUsd.toFixed(2)} ${tx.asset}` },
      { at: createdIso, level: "warn", actor: "fraud-agent", message: "Fraud analysis completed: risk 0.88 — velocity + counterparty novelty signals." },
      { at: createdIso, level: "warn", actor: "escalation-agent", message: "Approval requested: workflow WAITING_FOR_HUMAN." },
    ],
    sourceEventIdempotencyKey: `seed-pending:${tx.id}`,
    humanReviewId: "rev_hist_pending",
    policyDecision: {
      decision: "REQUIRE_HUMAN_APPROVAL",
      matchedRules: [
        { ruleId: "pol-human-above-10k", name: "Mandatory human approval ≥ $10,000", reason: "amount threshold exceeded" },
        { ruleId: "pol-fraud-high-review", name: "Fraud risk ≥ 0.85 → human review", reason: "fraud band breached" },
      ],
      reasons: ["amount ≥ threshold", "fraud risk ≥ 0.85"],
      evaluatedAt: createdIso,
      engine: "deterministic-v1",
    },
    error: null,
    createdAt: createdIso,
    updatedAt: createdIso,
    completedAt: null,
    sandbox: true,
  };
}

type WorkflowStepLike = Omit<MimiWorkflow["steps"][number], never>;
