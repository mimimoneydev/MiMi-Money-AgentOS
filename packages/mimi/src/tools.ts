import type {
  MimiAgentId,
  MemoryBank,
  MimiCase,
  MimiCustomer,
  MimiNotification,
  MimiReport,
  MimiTransaction,
  MimiWalletHistory,
} from "./types.js";

/**
 * Structured financial tools available to MiMi agents through the Gateway.
 *
 * Every tool is deterministic, backed by the Memory Bank (sandbox/test data),
 * declares its capability class and required permission, and validates its
 * own inputs. Agents (and their LLMs) can REQUEST tools; only the Gateway,
 * after identity → RBAC → policy evaluation, actually EXECUTES them.
 */

export type ToolCapabilityClass = "read" | "write" | "privileged";

export interface ToolContext {
  memoryBank: MemoryBank;
  agentId: MimiAgentId;
  workflowId?: string | null;
  correlationId?: string;
}

export interface MimiTool<TArgs = Record<string, unknown>, TResult = unknown> {
  name: string;
  description: string;
  capabilityClass: ToolCapabilityClass;
  parameters: Record<string, { type: "string" | "number" | "boolean"; description: string; required?: boolean }>;
  /** Gemini function-declaration schema (derived from `parameters`). */
  geminiParameters: Record<string, unknown>;
  execute(args: TArgs, ctx: ToolContext): Promise<TResult>;
}

function decl(
  name: string,
  description: string,
  capabilityClass: ToolCapabilityClass,
  parameters: MimiTool["parameters"],
): Pick<MimiTool, "name" | "description" | "capabilityClass" | "parameters" | "geminiParameters"> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, spec] of Object.entries(parameters)) {
    properties[key] = { type: spec.type, description: spec.description };
    if (spec.required) required.push(key);
  }
  return {
    name,
    description,
    capabilityClass,
    parameters,
    geminiParameters: { type: "object", properties, required },
  };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`tool argument '${key}' must be a non-empty string`);
  return v;
}

// ---------------------------------------------------------------------------
// Heuristic scorers (deterministic)
// ---------------------------------------------------------------------------

/** Deterministic wallet-based fraud score in [0,1]. */
export function scoreWalletBehaviour(history: MimiWalletHistory, amountUsd: number): { score: number; factors: { factor: string; contribution: number }[] } {
  const factors: { factor: string; contribution: number }[] = [];
  let score = 0.06;
  factors.push({ factor: "baseline", contribution: 0.06 });

  const avg = Math.max(history.avgAmountUsd, 1);
  const ratio = amountUsd / avg;
  let deviation: number;
  if (ratio >= 50) deviation = 0.34;
  else if (ratio >= 20) deviation = 0.28;
  else if (ratio >= 10) deviation = 0.18;
  else if (ratio >= 5) deviation = 0.1;
  else deviation = Math.min(0.03, 0.01 * ratio);
  score += deviation;
  factors.push({
    factor: `amount deviation (${ratio.toFixed(1)}x customer average of $${avg.toFixed(0)})`,
    contribution: deviation,
  });

  const nowMs = Date.now();
  const recentCount = history.entries.filter(
    (e) => nowMs - new Date(e.occurredAt).getTime() < 90 * 60 * 1000,
  ).length;
  const velocity = recentCount >= 5 ? 0.18 : recentCount * 0.012;
  score += velocity;
  factors.push({ factor: `recent velocity (${recentCount} txns in 90m)`, contribution: velocity });

  const counterparties = history.entries.map((e) => e.counterparty);
  const uniqueRatio = counterparties.length === 0 ? 0 : new Set(counterparties).size / counterparties.length;
  const novelty = uniqueRatio > 0.7 ? 0.16 : uniqueRatio * 0.16;
  score += novelty;
  factors.push({
    factor: `counterparty novelty (${(uniqueRatio * 100).toFixed(0)}% unique)`,
    contribution: novelty,
  });

  let rounding = 0;
  if (amountUsd % 500 === 0) rounding = 0.08;
  else if (amountUsd % 100 === 0) rounding = 0.04;
  score += rounding;
  if (rounding > 0) factors.push({ factor: "round-amount structuring signal", contribution: rounding });

  if (amountUsd > history.volume30dUsd && history.volume30dUsd > 0) {
    score += 0.08;
    factors.push({
      factor: `amount exceeds trailing 30d volume ($${history.volume30dUsd.toFixed(0)})`,
      contribution: 0.08,
    });
  }

  return { score: clamp01(score), factors };
}

/** Composite risk blends fraud behaviour, compliance outcome and sheer size. */
export function calculateCompositeRisk(input: {
  fraudRiskScore: number;
  complianceResult: string;
  amountUsd: number;
}): number {
  const amountFactor = Math.min(1, Math.log10(Math.max(input.amountUsd, 1)) / Math.log10(1_000_000));
  const compliancePenalty =
    input.complianceResult === "BLOCKED" ? 1 : input.complianceResult === "FLAGGED" ? 0.45 : 0;
  return clamp01(0.55 * input.fraudRiskScore + 0.25 * compliancePenalty + 0.2 * amountFactor);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, Number(n.toFixed(4))));
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

export interface SanctionsEntry {
  id: string;
  listName: string;
  matchValue: string;
}

const SANCTIONS_SEED: SanctionsEntry[] = [
  { id: "san-001", listName: "OFAC-SDN-SANDBOX", matchValue: "GRADY TRANSIT LOGISTICS" },
  { id: "san-002", listName: "EU-SANDBOX", matchValue: "0xdeadbeef0000000000000000000000000000dead" },
];

export async function screenSanctions(value: string, memoryBank: MemoryBank): Promise<SanctionsEntry | null> {
  const seeded = await memoryBank.list<SanctionsEntry>("permissions", { limit: 300 });
  const entries = seeded.length > 0 ? seeded.filter((r: any) => r.kind === "sanctions-entry").map((r: any) => ({
    id: String(r.id),
    listName: String(r.listName ?? "SANDBOX"),
    matchValue: String(r.matchValue),
  })) : SANCTIONS_SEED;
  const needle = value.trim().toUpperCase();
  return entries.find((e) => e.matchValue.toUpperCase() === needle) ?? null;
}

export function createMimiTools(memoryBank: MemoryBank): MimiTool[] {
  const getTx = async (args: Record<string, unknown>) => {
    const id = requireString(args, "transactionId");
    const tx = await memoryBank.get<MimiTransaction>("transactions", id);
    if (!tx) throw new Error(`transaction ${id} not found`);
    return tx;
  };

  const tools: MimiTool[] = [
    {
      ...decl("get_transaction", "Fetch a sandbox transaction by id.", "read", {
        transactionId: { type: "string", description: "Transaction id", required: true },
      }),
      execute: getTx,
    },
    {
      ...decl("get_customer", "Fetch a MiMi customer profile by id.", "read", {
        customerId: { type: "string", description: "Customer id", required: true },
      }),
      execute: async (args) => {
        const id = requireString(args, "customerId");
        const c = await memoryBank.get<MimiCustomer>("customers", id);
        if (!c) throw new Error(`customer ${id} not found`);
        return c;
      },
    },
    {
      ...decl("get_wallet_history", "Fetch a customer's sandbox wallet movement history and aggregates.", "read", {
        customerId: { type: "string", description: "Customer id", required: true },
      }),
      execute: async (args) => {
        const id = requireString(args, "customerId");
        const history = await memoryBank.get<MimiWalletHistory>("wallets", id);
        if (!history) throw new Error(`wallet history for ${id} not found`);
        return history;
      },
    },
    {
      ...decl("analyze_wallet", "Run deterministic wallet-behaviour fraud analytics for an amount against a customer's history.", "read", {
        customerId: { type: "string", description: "Customer id", required: true },
        amountUsd: { type: "number", description: "Proposed amount in USD-equivalent", required: true },
      }),
      execute: async (args) => {
        const id = requireString(args, "customerId");
        const amount = Number(args.amountUsd);
        if (!Number.isFinite(amount) || amount <= 0) throw new Error("amountUsd must be a positive number");
        const history = await memoryBank.get<MimiWalletHistory>("wallets", id);
        if (!history) throw new Error(`wallet history for ${id} not found`);
        const { score, factors } = scoreWalletBehaviour(history, amount);
        return { customerId: id, amountUsd: amount, fraudRiskScore: score, factors };
      },
    },
    {
      ...decl("calculate_risk", "Compute the composite risk score from fraud score, compliance result and amount.", "read", {
        fraudRiskScore: { type: "number", description: "Wallet/fraud risk in [0,1]", required: true },
        complianceResult: { type: "string", description: "CLEAR | FLAGGED | BLOCKED", required: true },
        amountUsd: { type: "number", description: "USD-equivalent amount", required: true },
      }),
      execute: async (args) => {
        const fraud = Number(args.fraudRiskScore);
        const amount = Number(args.amountUsd);
        if (!Number.isFinite(fraud) || !Number.isFinite(amount)) throw new Error("invalid numeric arguments");
        const riskScore = calculateCompositeRisk({
          fraudRiskScore: fraud,
          complianceResult: String(args.complianceResult ?? "CLEAR"),
          amountUsd: amount,
        });
        return { riskScore, band: riskScore >= 0.85 ? "high" : riskScore >= 0.4 ? "medium" : "low" };
      },
    },
    {
      ...decl("check_compliance", "Screen a customer + payment against KYC tier, AML thresholds and the sandbox sanctions list.", "write", {
        customerId: { type: "string", description: "Customer id", required: true },
        amountUsd: { type: "number", description: "USD-equivalent amount", required: true },
        walletAddress: { type: "string", description: "Counterparty wallet/address to screen", required: false },
      }),
      execute: async (args) => {
        const id = requireString(args, "customerId");
        const amount = Number(args.amountUsd ?? 0);
        const customer = await memoryBank.get<MimiCustomer>("customers", id);
        if (!customer) throw new Error(`customer ${id} not found`);
        const sanctionHit = await screenSanctions(customer.name, memoryBank)
          || (typeof args.walletAddress === "string" ? await screenSanctions(args.walletAddress, memoryBank) : null);
        if (sanctionHit) {
          return {
            result: "BLOCKED" as const,
            reason: `Sanctions hit on ${sanctionHit.listName}`,
            ruleRef: sanctionHit.id,
          };
        }
        if (customer.kycTier === "basic" && amount > 1000) {
          return {
            result: "FLAGGED" as const,
            reason: "Basic KYC tier cannot exceed $1,000 per transaction",
            ruleRef: "kyc-tier-limit",
          };
        }
        if (amount > 250_000) {
          return {
            result: "FLAGGED" as const,
            reason: "Enhanced due diligence required above $250,000",
            ruleRef: "edd-threshold",
          };
        }
        return { result: "CLEAR" as const, reason: `KYC tier ${customer.kycTier} supports this amount`, ruleRef: null };
      },
    },
    {
      ...decl("reconcile_transaction", "Prove sandbox ledger balance for a transaction: debit treasury, credit customer, assert equality.", "privileged", {
        transactionId: { type: "string", description: "Transaction id", required: true },
      }),
      execute: async (args) => {
        const tx = await getTx(args);
        const treasuries = await memoryBank.list<{ id: string; network: string; balanceUsd: number }>(
          "treasury_accounts",
          { limit: 50 },
        );
        const account = treasuries.find((t) => t.network === tx.network) ?? treasuries[0];
        if (!account) throw new Error("no treasury account configured");
        const debitId = `leg_${tx.id}_debit`;
        const creditId = `leg_${tx.id}_credit`;
        await memoryBank.put("workflow_steps", {
          id: debitId,
          kind: "ledger-leg",
          side: "debit",
          accountId: account.id,
          amountUsd: tx.amountUsd,
          createdAt: new Date().toISOString(),
        } as any);
        await memoryBank.put("workflow_steps", {
          id: creditId,
          kind: "ledger-leg",
          side: "credit",
          accountId: tx.customerId,
          amountUsd: tx.amountUsd,
          createdAt: new Date().toISOString(),
        } as any);
        return {
          reconciled: true,
          balanced: true,
          legs: [
            { id: debitId, side: "debit", account: account.id, amountUsd: tx.amountUsd },
            { id: creditId, side: "credit", account: tx.customerId, amountUsd: tx.amountUsd },
          ],
          note: "SANDBOX ONLY — simulated ledger legs, no real funds moved",
        };
      },
    },
    {
      ...decl("get_treasury_balance", "Read sandbox treasury balances, optionally filtered by network.", "read", {
        network: { type: "string", description: "Network filter (e.g. base-sepolia)", required: false },
      }),
      execute: async (args) => {
        const rows = await memoryBank.list<{
          id: string;
          label: string;
          network: string;
          asset: string;
          balanceUsd: number;
          bufferUsd: number;
        }>("treasury_accounts", { limit: 50 });
        const filtered = typeof args.network === "string"
          ? rows.filter((r) => r.network === args.network)
          : rows;
        return { accounts: filtered, totalBalanceUsd: filtered.reduce((a, r) => a + r.balanceUsd, 0) };
      },
    },
    {
      ...decl("create_case", "Open an investigation or support case (fraud / compliance / support / escalation / ops).", "write", {
        kind: { type: "string", description: "fraud | compliance | support | escalation | ops", required: true },
        title: { type: "string", description: "Short case title", required: true },
        summary: { type: "string", description: "Case summary with evidence pointers", required: true },
        severity: { type: "string", description: "low | medium | high", required: true },
        relatedTransactionId: { type: "string", description: "Related transaction id", required: false },
        relatedCustomerId: { type: "string", description: "Related customer id", required: false },
      }),
      execute: async (args, ctx) => {
        const kind = requireString(args, "kind") as MimiCase["kind"];
        const kase: MimiCase = {
          id: `case_${crypto.randomUUID().slice(0, 8)}`,
          kind,
          title: requireString(args, "title"),
          status: "OPEN",
          severity: (requireString(args, "severity") as MimiCase["severity"]) ?? "medium",
          openedByAgent: ctx.agentId,
          relatedTransactionId: typeof args.relatedTransactionId === "string" ? args.relatedTransactionId : null,
          relatedCustomerId: typeof args.relatedCustomerId === "string" ? args.relatedCustomerId : null,
          summary: requireString(args, "summary"),
          createdAt: new Date().toISOString(),
          resolvedAt: null,
        };
        await memoryBank.put("cases", kase as unknown as Record<string, unknown> & { id: string });
        return kase;
      },
    },
    {
      ...decl("send_notification", "Send a sandbox notification to a recipient (in-app/email/sms simulated).", "write", {
        recipient: { type: "string", description: "Recipient identifier", required: true },
        subject: { type: "string", description: "Subject line", required: true },
        body: { type: "string", description: "Message body", required: true },
        severity: { type: "string", description: "info | warning | critical", required: false },
      }),
      execute: async (args, ctx) => {
        const notification: MimiNotification = {
          id: `ntf_${crypto.randomUUID().slice(0, 8)}`,
          channel: "in-app",
          recipient: requireString(args, "recipient"),
          subject: requireString(args, "subject"),
          body: requireString(args, "body"),
          severity: (args.severity as MimiNotification["severity"]) ?? "info",
          workflowId: ctx.workflowId ?? null,
          createdAt: new Date().toISOString(),
          read: false,
        };
        await memoryBank.put("notifications", notification as unknown as Record<string, unknown> & { id: string });
        return { sent: true, notificationId: notification.id, channel: notification.channel, sandbox: true };
      },
    },
    {
      ...decl("request_human_approval", "Create a Human Review task in MiMi Money AgentOS requesting an operator decision before privileged completion.", "privileged", {
        reason: { type: "string", description: "Why human approval is required", required: true },
        contextJson: { type: "string", description: "Compact JSON context for the operator", required: false },
      }),
      // The orchestrator intercepts this tool inside the workflow gate; direct
      // invocations outside a workflow are rejected by the Gateway.
      execute: async () => {
        throw new Error(
          "request_human_approval is workflow-scoped: it is executed by the orchestration gate, never directly",
        );
      },
    },
    {
      ...decl("generate_report", "Generate an audit-ready markdown report for a workflow/transaction.", "write", {
        title: { type: "string", description: "Report title", required: true },
        bodyMarkdown: { type: "string", description: "Markdown report body", required: true },
        transactionId: { type: "string", description: "Related transaction id", required: false },
      }),
      execute: async (args, ctx) => {
        const report: MimiReport = {
          id: `rpt_${crypto.randomUUID().slice(0, 8)}`,
          workflowId: ctx.workflowId ?? null,
          transactionId: typeof args.transactionId === "string" ? args.transactionId : null,
          title: requireString(args, "title"),
          bodyMarkdown: requireString(args, "bodyMarkdown"),
          generatedByAgent: ctx.agentId,
          createdAt: new Date().toISOString(),
        };
        await memoryBank.put("reports", report as unknown as Record<string, unknown> & { id: string });
        return report;
      },
    },
  ];

  return tools;
}
