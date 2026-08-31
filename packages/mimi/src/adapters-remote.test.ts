import { describe, expect, it } from "vitest";
import { InMemoryMemoryBank, MimiEventBus, MimiService, GoogleAdkRemoteRuntime } from "@mimi/agentos-core";
import type { AdkRunSnapshot } from "@mimi/agentos-core";

async function buildService() {
  const memoryBank = new InMemoryMemoryBank();
  const bus = new MimiEventBus({ mode: "in-memory" });
  const service = new MimiService({ memoryBank, bus, adkMode: "local-simulation" });
  await service.start();
  return { service, bus };
}

describe("MiMi Agent Gateway HTTP contract (spec §9)", () => {
  it("authorizes tool calls through identity → RBAC → policy → audit", async () => {
    const { service } = await buildService();
    const res = await service.gateway.invoke({
      agentId: "risk-agent",
      toolName: "calculate_risk",
      args: { fraudRiskScore: 0.2, complianceResult: "CLEAR", amountUsd: 250 },
    });
    expect(res.status).toBe("executed");
    expect(res.auditId).toMatch(/^aud_/);
  });

  it("denies cross-department privilege escalation", async () => {
    const { service } = await buildService();
    // Support agent has no reconcile_transaction permission.
    const res = await service.gateway.invoke({
      agentId: "support-agent",
      toolName: "reconcile_transaction",
      args: { transactionId: "txn_x" },
    });
    expect(res.status).toBe("denied");
    expect(res.error).toContain("RBAC");
  });

  it("routes agent-to-agent delegation through reporting lines only", async () => {
    const { service } = await buildService();
    const fleet = await service.fleet();
    // fraud-agent may not delegate to reconciliation-agent: not its manager,
    // and it holds no agent-coordination capability.
    const from = fleet.find((a) => a.id === "fraud-agent")!;
    const target = fleet.find((a) => a.id === "reconciliation-agent")!;
    const isManager = target.managerId === from.id;
    const coordinates = from.capabilities.includes("agent-coordination");
    expect(isManager || coordinates).toBe(false);
    // The orchestrator coordinates every department by design.
    const orchestrator = fleet.find((a) => a.id === "orchestrator")!;
    expect(orchestrator.capabilities).toContain("agent-coordination");
  });
});

describe("GoogleAdkRemoteRuntime", () => {
  it("executes runs against a remote google-adk service and persists snapshots", async () => {
    const memoryBank = new InMemoryMemoryBank();
    const snapshot: AdkRunSnapshot & { id: string } = {
      id: "run_remote1",
      runId: "run_remote1",
      agentId: "fraud-agent",
      sessionId: "ses_remote1",
      workflowId: null,
      stepKey: null,
      status: "COMPLETED",
      model: "gemini-3.6-flash",
      adapterMode: "remote",
      iterations: 3,
      toolCalls: [{ toolName: "analyze_wallet", args: {}, gatewayDecision: "ALLOW", ok: true, resultSummary: "{\"fraudRiskScore\":0.9}", latencyMs: 5 }],
      artifacts: { analyze_wallet: { fraudRiskScore: 0.9 } },
      outputText: "Fraud analysis completed: risk 0.90.",
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      tokenUsageEstimate: 900,
      costUsdEstimate: 0.00135,
      sessionEvents: [],
    };
    const fetchImpl = (async (_url: unknown, init?: { method?: string; body?: string }) => ({
      ok: true,
      status: 200,
      json: async () => ({ run: snapshot }),
    })) as unknown as typeof fetch;

    const runtime = new GoogleAdkRemoteRuntime(memoryBank, {
      baseUrl: "http://adk.test",
      fetchImpl,
      timeoutMs: 5_000,
    });
    runtime.gatewayToolCallUrl = "http://control-plane/api/mimi/gateway/tool-call";
    await memoryBank.put("agents", {
      id: "fraud-agent",
      budget: { monthlyLimitUsd: 15, spentUsd: 0, currency: "USD", hardStop: true, periodStartAt: "2026-08-01", updatedAt: new Date().toISOString() },
      stats: { runsTotal: 0, runsSucceeded: 0, runsFailed: 0, lastRunAt: null, lastError: null },
    });

    const run = await runtime.execute({
      agentId: "fraud-agent",
      instruction: "Assess fraud risk for txn_1",
      context: { transactionId: "txn_1" },
    });

    expect(run.runId).toBeTruthy();
    expect(run.adapterMode).toBe("remote");
    expect(run.outputText).toContain("0.90");
    const persisted = await runtime.inspectRun(run.runId);
    expect(persisted?.status).toBe("COMPLETED");
    const agent = await memoryBank.get<{ budget: { spentUsd: number }; stats: { runsTotal: number } }>("agents", "fraud-agent");
    expect(agent?.budget.spentUsd).toBeCloseTo(0.00135, 6);
    expect(agent?.stats.runsTotal).toBe(1);
  });

  it("marks runs FAILED when the remote service errors", async () => {
    const memoryBank = new InMemoryMemoryBank();
    const fetchImpl = (async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: "GOOGLE_API_KEY is not configured on the MiMi ADK runtime" }),
    })) as unknown as typeof fetch;
    const runtime = new GoogleAdkRemoteRuntime(memoryBank, {
      baseUrl: "http://adk.test",
      fetchImpl,
      timeoutMs: 5_000,
    });
    await expect(
      runtime.execute({ agentId: "payment-agent", instruction: "x", context: {} }),
    ).rejects.toThrow(/not configured/);
    const stored = await runtime.inspectRun((await runtime.listRuns())[0]!.runId);
    expect(stored?.status).toBe("FAILED");
    expect(stored?.error).toContain("not configured");
  });
});
