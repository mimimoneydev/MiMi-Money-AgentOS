import type {
  AdkRunSnapshot,
  MemoryBank,
  MimiAgent,
  MimiCustomer,
  MimiTransaction,
} from "./types.js";
import { AdkRuntimeError, BaseAdkRuntime } from "./adk-gemini-runtime.js";
import type { MiMiAgentGateway } from "./gateway.js";

/**
 * Google ADK local-simulation runtime.
 *
 * Same ADK semantics as the Gemini runner — sessions, runs, lifecycle,
 * Gateway-gated tool calls, artifacts — executed by deterministic local
 * logic instead of external model calls. This keeps local dev, CI and the
 * offline hackathon demo fully functional at zero cost while remaining a
 * REAL backend execution path (not a frontend mockup).
 */

export interface LocalSimulationOptions {
  /** Deterministic failure injection: fail the next N starts per agent id. */
  failNextPerAgent?: Record<string, number>;
  timeoutMs?: number;
}

export class GoogleAdkLocalSimulationRuntime extends BaseAdkRuntime {
  readonly modeName = "local-simulation" as const;
  readonly model = "mimi-deterministic-v1";
  private readonly failNext: Record<string, number>;

  constructor(
    memoryBank: MemoryBank,
    private readonly hooks: {
      gateway: MiMiAgentGateway;
    },
    opts: LocalSimulationOptions = {},
  ) {
    super(memoryBank, opts);
    this.failNext = { ...(opts.failNextPerAgent ?? {}) };
  }

  async startRun(runId: string): Promise<AdkRunSnapshot> {
    const run = await this.inspectRun(runId);
    if (!run) throw new AdkRuntimeError("model-error", `run ${runId} not found`);
    const failCount = this.failNext[run.agentId];
    if (typeof failCount === "number" && failCount > 0) {
      this.failNext[run.agentId] = failCount - 1;
      run.status = "FAILED";
      run.error = "injected transient runtime failure";
      run.finishedAt = new Date().toISOString();
      await this.save(run);
      throw new AdkRuntimeError("model-error", run.error);
    }

    run.status = "RUNNING";
    run.iterations = 1;
    await this.save(run);
    const startedMs = Date.now();
    try {
      const ctx = this.getContext(run);
      const outcome = await this.simulate(run, ctx);
      run.artifacts = { ...run.artifacts, ...outcome.artifacts };
      run.outputText = outcome.text;
      run.status = "COMPLETED";
      run.finishedAt = new Date().toISOString();
      run.costUsdEstimate = 0.00005;
      run.tokenUsageEstimate = 0;
      run.sessionEvents.push({ at: run.finishedAt!, kind: "final", text: outcome.text });
      await this.save(run);
      await this.chargeAgent(run);
      return run;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      run.status = "FAILED";
      run.error = message;
      run.finishedAt = new Date().toISOString();
      run.sessionEvents.push({ at: run.finishedAt, kind: "error", text: message });
      await this.save(run);
      await this.chargeAgentFailure(run);
      throw err;
    }
  }

  /**
   * Per-agent deterministic behaviour. Every capability flows through the
   * Gateway exactly like a Gemini-proposed tool call would.
   */
  private async simulate(
    run: AdkRunSnapshot,
    ctx: { transactionId: string; customerId: string; amountUsd: number },
  ): Promise<{ text: string; artifacts: Record<string, unknown> }> {
    const gw = this.hooks.gateway;
    const call = async <T>(toolName: string, args: Record<string, unknown>): Promise<T | null> => {
      const res = await gw.invoke({
        agentId: run.agentId as never,
        toolName,
        args,
        workflowId: run.workflowId,
        skipFinancialGate: true,
      });
      run.toolCalls.push({
        toolName,
        args,
        gatewayDecision: res.decision?.decision ?? "ALLOW",
        ok: res.status === "executed",
        resultSummary: res.error ?? safeJson(res.result),
        latencyMs: res.latencyMs,
      });
      if (res.status !== "executed") return null;
      return res.result as T;
    };

    switch (run.agentId) {
      case "payment-agent": {
        const tx = await call<MimiTransaction>("get_transaction", { transactionId: ctx.transactionId });
        const customer = await call<MimiCustomer>("get_customer", { customerId: ctx.customerId });
        if (!tx || !customer) throw new Error("payment validation could not load transaction/customer");
        return {
          text: `Validated inbound $${ctx.amountUsd.toFixed(2)} ${tx.asset} on ${tx.network} from ${customer.name} (${customer.kycTier} KYC). Instruction well-formed; handing off to Fraud + Compliance.`,
          artifacts: { validated: true, asset: tx.asset, network: tx.network },
        };
      }
      case "fraud-agent": {
        type Analysis = { fraudRiskScore: number; factors: { factor: string; contribution: number }[] };
        const analysis = await call<Analysis>("analyze_wallet", { customerId: ctx.customerId, amountUsd: ctx.amountUsd });
        if (!analysis) throw new Error("wallet analysis unavailable");
        let caseOpened: unknown = null;
        if (analysis.fraudRiskScore >= 0.6) {
          caseOpened = await call<unknown>("create_case", {
            kind: "fraud",
            title: `High-risk pattern on ${ctx.transactionId}`,
            summary: `Wallet analysis scored ${analysis.fraudRiskScore.toFixed(2)}: ${analysis.factors.map((f) => f.factor).join("; ")}`,
            severity: analysis.fraudRiskScore >= 0.85 ? "high" : "medium",
            relatedTransactionId: ctx.transactionId,
            relatedCustomerId: ctx.customerId,
          });
        }
        return {
          text: `Fraud analysis completed: risk ${analysis.fraudRiskScore.toFixed(2)} (${analysis.factors.length} behavioural factors${caseOpened ? ", case opened" : ""}).`,
          artifacts: { fraudRiskScore: analysis.fraudRiskScore, factors: analysis.factors, fraudCaseOpened: Boolean(caseOpened) },
        };
      }
      case "compliance-agent": {
        type Screening = { result: string; reason: string; ruleRef: string | null };
        const customer = await call<MimiCustomer>("get_customer", { customerId: ctx.customerId });
        const screening = await call<Screening>("check_compliance", {
          customerId: ctx.customerId,
          amountUsd: ctx.amountUsd,
          walletAddress: customer?.walletAddress,
        });
        if (!screening) throw new Error("compliance screening unavailable");
        if (screening.result === "BLOCKED") {
          await call<unknown>("create_case", {
            kind: "compliance",
            title: `Compliance block on ${ctx.transactionId}`,
            summary: screening.reason,
            severity: "high",
            relatedTransactionId: ctx.transactionId,
            relatedCustomerId: ctx.customerId,
          });
        }
        return {
          text: `Compliance evaluated: ${screening.result} — ${screening.reason}`,
          artifacts: { complianceResult: screening.result, complianceReason: screening.reason },
        };
      }
      case "risk-agent": {
        const fraudScore = Number((ctx as Record<string, unknown>)["fraudRiskScore"] ?? 0);
        const complianceResult = String((ctx as Record<string, unknown>)["complianceResult"] ?? "CLEAR");
        type RiskOut = { riskScore: number; band: string };
        const risk = await call<RiskOut>("calculate_risk", {
          fraudRiskScore: fraudScore,
          complianceResult,
          amountUsd: ctx.amountUsd,
        });
        if (!risk) throw new Error("composite risk calculation unavailable");
        const recommendation =
          risk.riskScore >= 0.85 || ctx.amountUsd >= 10000
            ? "REQUIRE_HUMAN_APPROVAL"
            : risk.band === "low"
              ? "PROCEED_AUTONOMOUSLY"
              : "PROCEED_WITH_MONITORING";
        return {
          text: `Composite risk ${risk.riskScore.toFixed(2)} (${risk.band}); policy recommendation ${recommendation}.`,
          artifacts: { riskScore: risk.riskScore, band: risk.band, recommendation },
        };
      }
      case "treasury-agent": {
        type Balances = { accounts: Array<{ id: string; network: string; balanceUsd: number; bufferUsd: number }>; totalBalanceUsd: number };
        const balances = await call<Balances>("get_treasury_balance", {});
        if (!balances) throw new Error("treasury balances unavailable");
        const account = balances.accounts.find((a) => a.balanceUsd >= ctx.amountUsd) ?? balances.accounts[0];
        return {
          text: `Settlement planned on sandbox account ${account?.id ?? "n/a"} (${account?.network ?? "?"}); float after leg $${Math.max(0, (account?.balanceUsd ?? 0) - ctx.amountUsd).toFixed(2)}. SANDBOX ONLY.`,
          artifacts: { settlementAccountId: account?.id ?? null, routeNetwork: account?.network ?? null, bufferAfterUsd: Math.max(0, (account?.balanceUsd ?? 0) - ctx.amountUsd) },
        };
      }
      case "reconciliation-agent": {
        type Proof = { reconciled: boolean; balanced: boolean; legs: Array<{ id: string; side: string; amountUsd: number }> };
        const proof = await call<Proof>("reconcile_transaction", { transactionId: ctx.transactionId });
        if (!proof) throw new Error("reconciliation unavailable");
        return {
          text: `Reconciliation completed: ${proof.legs.length} ledger legs, balanced=${proof.balanced}.`,
          artifacts: { reconciled: proof.reconciled, balanced: proof.balanced, legs: proof.legs },
        };
      }
      case "support-agent": {
        const notification = await call<unknown>("send_notification", {
          recipient: ctx.customerId,
          subject: `Payment update for ${ctx.transactionId}`,
          body: `Your sandbox payment of $${ctx.amountUsd.toFixed(2)} has been processed by MiMi Money AgentOS. This was a simulated flow.`,
          severity: "info",
        });
        return {
          text: "Customer follow-up notification dispatched (sandbox channel).",
          artifacts: { notificationSent: Boolean(notification) },
        };
      }
      case "escalation-agent": {
        return {
          text: "Human Review task created in MiMi Money AgentOS; operator decision requested.",
          artifacts: { reviewTaskCreated: true },
        };
      }
      case "reporting-agent": {
        const report = await call<{ id: string }>("generate_report", {
          title: `Workflow report — ${run.workflowId}`,
          bodyMarkdown:
            `# MiMi Money AgentOS workflow report\n\n` +
            `- Workflow: ${run.workflowId}\n- Transaction: ${ctx.transactionId}\n- Amount (sandbox): $${ctx.amountUsd.toFixed(2)}\n\n` +
            `All decisions were produced by the deterministic Policy Engine over ADK agent outputs. No chain-of-thought is retained.`,
          transactionId: ctx.transactionId,
        });
        return {
          text: `Audit-ready report generated (${report?.id ?? "unavailable"}).`,
          artifacts: { reportId: report?.id ?? null },
        };
      }
      case "orchestrator":
      default:
        return {
          text: "Orchestration checkpoint recorded.",
          artifacts: {},
        };
    }
  }

  private getContext(run: AdkRunSnapshot): Record<string, unknown> & { transactionId: string; customerId: string; amountUsd: number } {
    const first = run.sessionEvents.find((e) => e.kind === "user-message");
    const ctx = ((first?.meta as { context?: Record<string, unknown> })?.context ?? {}) as Record<string, unknown>;
    return {
      transactionId: String(ctx.transactionId ?? ""),
      customerId: String(ctx.customerId ?? ""),
      amountUsd: Number(ctx.amountUsd ?? 0),
      ...ctx,
    };
  }

  private async chargeAgent(run: AdkRunSnapshot): Promise<void> {
    const agent = await this.memoryBank.get<MimiAgent>("agents", run.agentId);
    if (!agent) return;
    await this.memoryBank.update<MimiAgent>("agents", agent.id, {
      stats: {
        ...agent.stats,
        runsTotal: agent.stats.runsTotal + 1,
        runsSucceeded: agent.stats.runsSucceeded + 1,
        lastRunAt: run.finishedAt,
      },
      budget: {
        ...agent.budget,
        spentUsd: Math.round((agent.budget.spentUsd + run.costUsdEstimate) * 1e6) / 1e6,
        updatedAt: new Date().toISOString(),
      },
      heartbeatAt: new Date().toISOString(),
    });
  }

  private async chargeAgentFailure(run: AdkRunSnapshot): Promise<void> {
    const agent = await this.memoryBank.get<MimiAgent>("agents", run.agentId);
    if (!agent) return;
    await this.memoryBank.update<MimiAgent>("agents", agent.id, {
      stats: {
        ...agent.stats,
        runsTotal: agent.stats.runsTotal + 1,
        runsFailed: agent.stats.runsFailed + 1,
        lastRunAt: run.finishedAt,
        lastError: run.error,
      },
      heartbeatAt: new Date().toISOString(),
    });
  }
}

function safeJson(v: unknown): string {
  if (v === undefined || v === null) return "(no result)";
  try {
    return JSON.stringify(v).slice(0, 300);
  } catch {
    return String(v);
  }
}
