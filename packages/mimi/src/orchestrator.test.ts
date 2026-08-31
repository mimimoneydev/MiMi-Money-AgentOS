import { describe, expect, it, beforeEach, vi } from "vitest";
import { InMemoryMemoryBank } from "./memory-bank.js";
import { MimiEventBus } from "./event-bus.js";
import { PolicyEngine } from "./policy-engine.js";
import { MiMiAgentGateway } from "./gateway.js";
import { createMimiTools } from "./tools.js";
import { GoogleAdkLocalSimulationRuntime } from "./adk-local-runtime.js";
import { PaymentOrchestrator } from "./orchestrator.js";
import { seedMemoryBank } from "./seed.js";
import type { HumanReview, MemoryBank, MimiWorkflow } from "./types.js";

interface Harness {
  bank: MemoryBank;
  bus: MimiEventBus;
  orchestrator: PaymentOrchestrator;
}

function buildHarness(opts: { failNextPerAgent?: Record<string, number> } = {}): Harness {
  const bank = new InMemoryMemoryBank();
  const bus = new MimiEventBus({
    mode: "in-memory",
    sink: async (e) => void await bank.put("agent_events", { ...e, id: e.eventId }),
    handlerTimeoutMs: 5_000,
  });
  const policy = new PolicyEngine(bank);
  const gateway = new MiMiAgentGateway({ memoryBank: bank, bus, policyEngine: policy, tools: createMimiTools(bank) });
  const runtime = new GoogleAdkLocalSimulationRuntime(bank, { gateway }, { failNextPerAgent: opts.failNextPerAgent });
  const orchestrator = new PaymentOrchestrator({ memoryBank: bank, bus, gateway, runtime, policyEngine: policy });
  return { bank, bus, orchestrator };
}

async function settle(harness: Harness, ms = 400): Promise<void> {
  await harness.bus.idle?.();
  await new Promise((r) => setTimeout(r, ms));
  await harness.bus.idle?.();
}

describe("Payment workflow orchestration (real state machine)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await seedMemoryBank(h.bank, { runtimeMode: "local-simulation" });
  });

  it("runs the $250 low-risk payment end-to-end autonomously", async () => {
    const { workflow } = await h.orchestrator.startPaymentWorkflow({
      customerId: "cus_amara",
      amountUsd: 250,
      idempotencyKey: "test-low-1",
    });
    await settle(h);
    const wf = await h.orchestrator.getWorkflow(workflow.id) as MimiWorkflow;
    expect(wf.status).toBe("COMPLETED");
    for (const step of wf.steps) {
      expect(step.status).toBe("COMPLETED");
    }
    const tx = await h.bank.get<any>("transactions", wf.transactionId);
    expect(tx.status).toBe("COMPLETED");
    // fraud step artifact proves real agent analysis ran
    const fraudStep = wf.steps.find((s) => s.key === "fraud")!;
    expect((fraudStep.artifacts as any).fraudRiskScore).toBeLessThan(0.4);
    // gate allowed autonomously — no review created
    expect(wf.humanReviewId).toBeNull();
    expect(wf.policyDecision!.decision).toBe("ALLOW");
  });

  it("routes $48,500 with fraud ≥0.85 into WAITING_FOR_HUMAN + creates a Human Review task", async () => {
    const { workflow } = await h.orchestrator.startPaymentWorkflow({
      customerId: "cus_chidi",
      amountUsd: 48_500,
      idempotencyKey: "test-high-1",
    });
    await settle(h);
    const wf = await h.orchestrator.getWorkflow(workflow.id) as MimiWorkflow;
    expect(wf.status).toBe("WAITING_FOR_HUMAN");
    expect(wf.humanReviewId).toBeTruthy();
    const gate = wf.steps.find((s) => s.key === "gate")!;
    expect(gate.status).toBe("WAITING");
    const review = await h.bank.get<HumanReview>("human_reviews", wf.humanReviewId!);
    expect(review!.status).toBe("PENDING");
    expect(review!.policyRuleIds).toContain("pol-fraud-high-review");
    // downstream steps must NOT have run
    expect(wf.steps.find((s) => s.key === "reconciliation")!.status).toBe("IDLE");
  });

  it("resumes the workflow after operator approval and settles", async () => {
    const { workflow } = await h.orchestrator.startPaymentWorkflow({
      customerId: "cus_chidi",
      amountUsd: 48_500,
      idempotencyKey: "test-high-2",
    });
    await settle(h);
    let wf = await h.orchestrator.getWorkflow(workflow.id) as MimiWorkflow;
    expect(wf.status).toBe("WAITING_FOR_HUMAN");

    await h.orchestrator.decideReview(wf.humanReviewId!, true, "operator-test", "verified");
    await settle(h);

    wf = await h.orchestrator.getWorkflow(workflow.id) as MimiWorkflow;
    expect(wf.status).toBe("COMPLETED");
    const tx = await h.bank.get<any>("transactions", wf.transactionId);
    expect(tx.status).toBe("COMPLETED");
    expect(wf.trace.some((t) => t.message.toLowerCase().includes("approved"))).toBe(true);
    // reconciliation actually proved balanced legs
    const recon = wf.steps.find((s) => s.key === "reconciliation")!;
    expect((recon.artifacts as any).balanced).toBe(true);
  });

  it("closes the flow without settlement on rejection", async () => {
    const { workflow } = await h.orchestrator.startPaymentWorkflow({
      customerId: "cus_chidi",
      amountUsd: 48_500,
      idempotencyKey: "test-reject-1",
    });
    await settle(h);
    let wf = await h.orchestrator.getWorkflow(workflow.id) as MimiWorkflow;
    await h.orchestrator.decideReview(wf.humanReviewId!, false, "operator-test", "suspected structuring");
    await settle(h);
    wf = await h.orchestrator.getWorkflow(workflow.id) as MimiWorkflow;
    const tx = await h.bank.get<any>("transactions", wf.transactionId);
    expect(tx.status).toBe("REJECTED");
    expect(tx.completedAt).toBeNull();
    expect((wf.steps.find((s) => s.key === "completion")!.artifacts as any).rejectedByHuman).toBe(true);
  });

  it("suppresses duplicate payment events by idempotency key", async () => {
    const first = await h.orchestrator.startPaymentWorkflow({ customerId: "cus_amara", amountUsd: 250, idempotencyKey: "dup-key" });
    const second = await h.orchestrator.startPaymentWorkflow({ customerId: "cus_amara", amountUsd: 250, idempotencyKey: "dup-key" });
    expect(second.duplicate).toBe(true);
    expect(second.workflow.id).toBe(first.workflow.id);
  });

  it("recovers in-flight workflows from persisted Memory Bank state after a crash", async () => {
    const { workflow } = await h.orchestrator.startPaymentWorkflow({
      customerId: "cus_wanjiru",
      amountUsd: 640,
      idempotencyKey: "recover-1",
    });
    await settle(h, 120);
    // Simulate crash mid-flight: mark a completed workflow's later steps as queued.
    const wf = await h.orchestrator.getWorkflow(workflow.id)!;
    // Build a fresh harness sharing the same bank but a NEW orchestrator (process restart).
    const bus2 = new MimiEventBus({ mode: "in-memory" });
    const policy2 = new PolicyEngine(h.bank);
    const gateway2 = new MiMiAgentGateway({ memoryBank: h.bank, bus: bus2, policyEngine: policy2, tools: createMimiTools(h.bank) });
    const runtime2 = new GoogleAdkLocalSimulationRuntime(h.bank, { gateway: gateway2 });
    const orchestrator2 = new PaymentOrchestrator({ memoryBank: h.bank, bus: bus2, gateway: gateway2, runtime: runtime2, policyEngine: policy2 });

    // Force an interrupted state: reset settlement-plan onward to QUEUED/IDLE.
    const doc = await h.bank.get<MimiWorkflow>("workflows", wf!.id);
    for (const step of doc!.steps) {
      if (["settlement-plan", "reconciliation"].includes(step.key)) {
        step.status = "QUEUED";
      }
    }
    doc!.status = "RUNNING";
    await h.bank.put("workflows", doc!);

    const recovered = await orchestrator2.recoverInFlight();
    expect(recovered).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 500));
    const after = await h.bank.get<MimiWorkflow>("workflows", wf!.id);
    expect(after!.status).toBe("COMPLETED");
    expect(after!.steps.every((s) => s.status === "COMPLETED")).toBe(true);
  });

  it("retries transient agent failures then completes", async () => {
    const failingHarness = buildHarness({ failNextPerAgent: { "fraud-agent": 2 } });
    await seedMemoryBank(failingHarness.bank, { runtimeMode: "local-simulation" });
    const { workflow } = await failingHarness.orchestrator.startPaymentWorkflow({
      customerId: "cus_amara",
      amountUsd: 250,
      idempotencyKey: "retry-1",
    });
    await settle(failingHarness, 600);
    const wf = await failingHarness.orchestrator.getWorkflow(workflow.id) as MimiWorkflow;
    expect(wf.status).toBe("COMPLETED");
    expect(wf.steps.find((s) => s.key === "fraud")!.attempt).toBeGreaterThanOrEqual(3);
  }, 15_000);

  it("escalates permanent failures into ESCALATED + ops case", async () => {
    const failingHarness = buildHarness({ failNextPerAgent: { "payment-agent": 99 } });
    await seedMemoryBank(failingHarness.bank, { runtimeMode: "local-simulation" });
    const { workflow } = await failingHarness.orchestrator.startPaymentWorkflow({
      customerId: "cus_amara",
      amountUsd: 250,
      idempotencyKey: "fail-1",
    });
    await settle(failingHarness, 700);
    const wf = await failingHarness.orchestrator.getWorkflow(workflow.id) as MimiWorkflow;
    expect(wf.status).toBe("ESCALATED");
    expect(wf.steps.find((s) => s.key === "validate")!.status).toBe("FAILED");
    const cases = await failingHarness.bank.list<any>("cases");
    expect(cases.some((c) => c.kind === "ops" && c.relatedTransactionId === wf.transactionId)).toBe(true);
  }, 15_000);

  it("publishes domain events on specialist topics during execution", async () => {
    const seen: string[] = [];
    for (const topic of ["mimi.fraud", "mimi.compliance", "mimi.risk", "mimi.reconciliation", "mimi.payments"] as const) {
      h.bus.subscribe(topic, (e) => {
        seen.push(`${topic}:${e.type}`);
      });
    }
    await h.orchestrator.startPaymentWorkflow({ customerId: "cus_amara", amountUsd: 250, idempotencyKey: "events-1" });
    await settle(h);
    expect(seen).toContain("mimi.fraud:fraud.analysis-completed");
    expect(seen).toContain("mimi.compliance:compliance.evaluated");
    expect(seen).toContain("mimi.reconciliation:reconciliation.completed");
    expect(seen).toContain("mimi.payments:payment.completed");
  });

  it("never persists chain-of-thought — only summaries and tool artifacts", async () => {
    await h.orchestrator.startPaymentWorkflow({ customerId: "cus_chidi", amountUsd: 48_500, idempotencyKey: "cot-1" });
    await settle(h);
    const runs = await h.bank.list<any>("agent_runs", { limit: 100 });
    for (const run of runs) {
      const serialized = JSON.stringify(run).toLowerCase();
      expect(serialized.includes("chain-of-thought")).toBe(false);
      expect(run.sessionEvents.every((ev: any) => ev.kind !== "reasoning")).toBe(true);
    }
  });
});
