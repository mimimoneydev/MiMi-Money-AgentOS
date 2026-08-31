import type {
  AuditRecord,
  MimiAgent,
  MimiAgentId,
  MimiEventBusContract,
  MemoryBank,
  PolicyDecision,
} from "./types.js";
import { PolicyEngine } from "./policy-engine.js";
import type { MimiTool, ToolContext } from "./tools.js";

export interface GatewayOptions {
  memoryBank: MemoryBank;
  bus: MimiEventBusContract;
  policyEngine: PolicyEngine;
  tools?: MimiTool[];
  rateLimitPerMinute?: number;
  now?: () => Date;
}

export interface GatewayInvocation {
  agentId: MimiAgentId | "operator";
  toolName: string;
  args: Record<string, unknown>;
  workflowId?: string | null;
  correlationId?: string;
  /** Financial context attached by callers that know it (orchestrator gate). */
  amountUsd?: number;
  fraudRiskScore?: number;
  complianceResult?: string;
  sanctionedHit?: boolean;
  asset?: string;
  network?: string;
  skipFinancialGate?: boolean;
}

export interface GatewayInvocationResult {
  status: "executed" | "denied" | "approval-required";
  decision: PolicyDecision | null;
  result?: unknown;
  error?: string;
  auditId: string;
  latencyMs: number;
}

/**
 * MiMi Agent Gateway — the ONLY path from agents to privileged capability.
 *
 *   Agent identity → RBAC/capability check → deterministic Policy Engine →
 *   (human approval when required) → authorized tool → result verification →
 *   Pub/Sub event → Firestore persistence → audit record.
 *
 * LLM output can propose tool calls, but can never bypass this pipeline.
 */
export class MiMiAgentGateway {
  readonly policyEngine: PolicyEngine;
  private readonly memoryBank: MemoryBank;
  private readonly bus: MimiEventBusContract;
  private readonly tools = new Map<string, MimiTool>();
  private readonly rateWindows = new Map<string, number[]>();
  private readonly rateLimitPerMinute: number;
  private readonly inflight = new Map<string, Promise<GatewayInvocationResult>>();
  private readonly now: () => Date;

  constructor(opts: GatewayOptions) {
    this.memoryBank = opts.memoryBank;
    this.bus = opts.bus;
    this.policyEngine = opts.policyEngine;
    this.rateLimitPerMinute = opts.rateLimitPerMinute ?? 60;
    this.now = opts.now ?? (() => new Date());
    const provided = opts.tools ?? [];
    if (provided.length === 0) throw new Error("Gateway requires a non-empty tool registry");
    for (const t of provided) this.tools.set(t.name, t);
  }

  listTools(): MimiTool[] {
    return [...this.tools.values()];
  }

  getTool(name: string): MimiTool | undefined {
    return this.tools.get(name);
  }

  /** Gemini function declarations limited to an agent's permissions. */
  geminiToolDeclarationsFor(agent: MimiAgent): Array<Record<string, unknown>> {
    return this.listTools()
      .filter((t) => agent.permissions.includes(t.name) && t.name !== "request_human_approval")
      .map((t) => ({ name: t.name, description: t.description, parameters: t.geminiParameters }));
  }

  /**
   * Authorize-and-execute one tool invocation. Idempotent per
   * `${agentId}:${toolName}:${JSON.stringify(args)}` while in flight.
   */
  async invoke(invocation: GatewayInvocation): Promise<GatewayInvocationResult> {
    const startedAt = Date.now();
    const key = `${invocation.agentId}:${invocation.toolName}:${stableKey(invocation.args)}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const p = this.invokeInner(invocation, startedAt).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }

  private async invokeInner(inv: GatewayInvocation, startedAtMs: number): Promise<GatewayInvocationResult> {
    const auditBase = {
      actor: inv.agentId as AuditRecord["actor"],
      action: `gateway.${inv.toolName}`,
      subjectType: "tool-invocation",
      subjectId: inv.toolName,
      workflowId: inv.workflowId ?? null,
    };

    // 1) Identity ----------------------------------------------------------
    let agent: MimiAgent | null = null;
    if (inv.agentId !== "operator") {
      agent = await this.memoryBank.get<MimiAgent>("agents", inv.agentId);
      if (!agent) {
        return this.deny(auditBase, inv, null, "unknown agent identity", startedAtMs);
      }
    }

    // 2) Tool existence ----------------------------------------------------
    const tool = this.tools.get(inv.toolName);
    if (!tool) {
      return this.deny(auditBase, inv, null, `unknown tool '${inv.toolName}'`, startedAtMs);
    }

    // 3) Budget hard stop --------------------------------------------------
    if (agent && agent.budget.hardStop && agent.budget.spentUsd >= agent.budget.monthlyLimitUsd) {
      await this.memoryBank.update<MimiAgent>("agents", agent.id, { status: "PAUSED" });
      return this.deny(auditBase, inv, null, `budget hard-stop reached (${agent.id})`, startedAtMs, [
        { ruleId: "pol-budget-hard-stop", name: "Budget hard stop", reason: "monthly spend cap reached" },
      ]);
    }

    // 4) RBAC / permission check -------------------------------------------
    const rbacOk = !agent || agent.permissions.includes(inv.toolName);
    if (!rbacOk) {
      return this.deny(
        auditBase,
        inv,
        null,
        `RBAC: ${agent!.id} is not authorized for '${inv.toolName}'`,
        startedAtMs,
        [{ ruleId: "pol-tool-rbac", name: "RBAC + tool authorization", reason: "permission missing from agent grant" }],
      );
    }

    // 5) Rate limiting -----------------------------------------------------
    const windowKey = `${inv.agentId}:${inv.toolName}`;
    const count = this.bumpRateWindow(windowKey);
    const rateExceeded = count > this.rateLimitPerMinute;

    // 6) Deterministic policy evaluation ------------------------------------
    const decision = await this.policyEngine.evaluate({
      actionType: inv.skipFinancialGate ? "tool-invocation" : "financial-action",
      toolName: inv.toolName,
      agentId: agent?.id as MimiAgentId | undefined,
      amountUsd: inv.amountUsd,
      fraudRiskScore: inv.fraudRiskScore,
      complianceResult: inv.complianceResult,
      sanctionedHit: inv.sanctionedHit,
      asset: inv.asset,
      network: inv.network,
      customerKycTier: undefined,
      rateWindow: rateExceeded
        ? { key: windowKey, count, limitPerMinute: this.rateLimitPerMinute }
        : null,
      budgetExceeded: false,
    });

    if (decision.decision === "DENY") {
      return this.deny(auditBase, inv, decision, decision.reasons.join("; "), startedAtMs, decision.matchedRules);
    }
    if (decision.decision === "REQUIRE_HUMAN_APPROVAL") {
      return this.approvalRequired(auditBase, inv, decision, startedAtMs);
    }

    // 7) Execute through the authorized tool --------------------------------
    const ctx: ToolContext = {
      memoryBank: this.memoryBank,
      agentId: (agent?.id ?? "system") as MimiAgentId,
      workflowId: inv.workflowId ?? null,
      correlationId: inv.correlationId,
    };
    let result: unknown;
    try {
      result = await tool.execute(inv.args, ctx);
    } catch (err) {
      return this.errorOutcome(auditBase, inv, decision, err, startedAtMs);
    }

    // 8) Verify result ------------------------------------------------------
    const verifyError = verifyResult(tool.name, result);

    // 9) Event + persistence + audit record ---------------------------------
    const auditId = await this.writeAudit({
      ...auditBase,
      at: this.now().toISOString(),
      outcome: verifyError ? "ERROR" : "EXECUTED",
      summary: verifyError ?? `${inv.agentId} invoked ${inv.toolName} → allowed`,
      detail: {
        tool: inv.toolName,
        capabilityClass: tool.capabilityClass,
        argsSummary: summarizeArgs(inv.args),
        decision: decision.decision,
        matchedRules: decision.matchedRules.map((m) => m.ruleId),
        sandbox: true,
      },
    });
    void this.bus.publish({
      topic: "mimi.audit",
      type: "gateway.decision",
      sourceAgent: "system",
      workflowId: inv.workflowId ?? null,
      correlationId: inv.correlationId,
      payload: {
        invocationId: auditId,
        agentId: inv.agentId,
        tool: inv.toolName,
        outcome: "EXECUTED",
        decision: decision.decision,
        sandbox: true,
      },
    }).catch(() => undefined);

    return {
      status: "executed",
      decision,
      result,
      auditId,
      latencyMs: Date.now() - startedAtMs,
    };
  }

  async writeAudit(record: Omit<AuditRecord, "id" | "sandbox"> & Partial<Pick<AuditRecord, "id">>): Promise<string> {
    const id = record.id ?? `aud_${crypto.randomUUID().slice(0, 12)}`;
    await this.memoryBank.put("audit", { ...record, id, sandbox: true } as unknown as Record<string, unknown> & { id: string });
    return id;
  }

  private bumpRateWindow(key: string): number {
    const cutoff = this.now().getTime() - 60_000;
    const arr = (this.rateWindows.get(key) ?? []).filter((t) => t >= cutoff);
    arr.push(this.now().getTime());
    this.rateWindows.set(key, arr);
    return arr.length;
  }

  private async deny(
    auditBase: Record<string, unknown>,
    inv: GatewayInvocation,
    decision: PolicyDecision | null,
    reason: string,
    startedAtMs: number,
    matchedRules?: PolicyDecision["matchedRules"],
  ): Promise<GatewayInvocationResult> {
    const auditId = await this.writeAudit({
      ...(auditBase as { actor: AuditRecord["actor"]; action: string; subjectType: string; subjectId: string | null; workflowId: string | null }),
      at: this.now().toISOString(),
      outcome: "DENIED",
      summary: reason,
      detail: { tool: inv.toolName, argsSummary: summarizeArgs(inv.args), matchedRules: matchedRules ?? [], sandbox: true },
    });
    void this.bus.publish({
      topic: "mimi.audit",
      type: "gateway.decision",
      sourceAgent: "system",
      workflowId: inv.workflowId ?? null,
      correlationId: inv.correlationId,
      payload: { agentId: inv.agentId, tool: inv.toolName, outcome: "DENIED", reason, sandbox: true },
    }).catch(() => undefined);
    return { status: "denied", decision, error: reason, auditId, latencyMs: Date.now() - startedAtMs };
  }

  private async approvalRequired(
    auditBase: Record<string, unknown>,
    inv: GatewayInvocation,
    decision: PolicyDecision,
    startedAtMs: number,
  ): Promise<GatewayInvocationResult> {
    const auditId = await this.writeAudit({
      ...(auditBase as { actor: AuditRecord["actor"]; action: string; subjectType: string; subjectId: string | null; workflowId: string | null }),
      at: this.now().toISOString(),
      outcome: "APPROVAL_REQUIRED",
      summary: decision.reasons.join("; "),
      detail: { tool: inv.toolName, matchedRules: decision.matchedRules.map((m) => m.ruleId), sandbox: true },
    });
    return { status: "approval-required", decision, auditId, latencyMs: Date.now() - startedAtMs };
  }

  private async errorOutcome(
    auditBase: Record<string, unknown>,
    inv: GatewayInvocation,
    decision: PolicyDecision | null,
    err: unknown,
    startedAtMs: number,
  ): Promise<GatewayInvocationResult> {
    const message = err instanceof Error ? err.message : String(err);
    const auditId = await this.writeAudit({
      ...(auditBase as { actor: AuditRecord["actor"]; action: string; subjectType: string; subjectId: string | null; workflowId: string | null }),
      at: this.now().toISOString(),
      outcome: "ERROR",
      summary: `tool failure: ${message}`,
      detail: { tool: inv.toolName, sandbox: true },
    });
    return { status: "denied", decision, error: message, auditId, latencyMs: Date.now() - startedAtMs };
  }
}

/** Lightweight post-execution verification of tool results. */
function verifyResult(toolName: string, result: unknown): string | null {
  if (result === undefined || result === null) return `${toolName} returned no result`;
  if (typeof result === "object") {
    const maybeAmount = (result as { amountUsd?: unknown }).amountUsd;
    if (maybeAmount !== undefined && (typeof maybeAmount !== "number" || !Number.isFinite(maybeAmount) || maybeAmount < 0)) {
      return `${toolName} produced invalid amountUsd`;
    }
  }
  return null;
}

function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "string" && v.length > 80 ? v.slice(0, 77) + "…" : v;
  }
  return out;
}

function stableKey(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeysDeep(v)]),
    );
  }
  return value;
}
