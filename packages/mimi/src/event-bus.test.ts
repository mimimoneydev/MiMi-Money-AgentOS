import { describe, expect, it, vi } from "vitest";
import { MimiEventBus } from "./event-bus.js";
import { resolvePubSubTarget } from "./google-pubsub-rest.js";
import type { MimiEvent } from "./types.js";

describe("MimiEventBus", () => {
  it("delivers events to topic subscribers exactly once per idempotency key", async () => {
    const bus = new MimiEventBus({ mode: "in-memory" });
    const handler = vi.fn();
    bus.subscribe("mimi.payments", handler);
    const first = await bus.publish({ topic: "mimi.payments", type: "payment.received", sourceAgent: "system", payload: {}, idempotencyKey: "k1" });
    expect(first.duplicate).toBe(false);
    const second = await bus.publish({ topic: "mimi.payments", type: "payment.received", sourceAgent: "system", payload: {}, idempotencyKey: "k1" });
    expect(second.duplicate).toBe(true);
    await bus.idle();
    expect(handler).toHaveBeenCalledTimes(1);
    const stats = bus.getStats();
    expect(stats.duplicatesSuppressed).toBe(1);
  });

  it("envelopes carry workflow/correlation/idempotency identity and timestamps", async () => {
    const bus = new MimiEventBus({ mode: "in-memory" });
    let received: MimiEvent | null = null;
    bus.subscribe("mimi.fraud", (e) => {
      received = e;
    });
    await bus.publish({
      topic: "mimi.fraud",
      type: "fraud.analysis-requested",
      sourceAgent: "orchestrator",
      targetAgent: "fraud-agent",
      workflowId: "wf_1",
      correlationId: "corr_1",
      payload: { transactionId: "txn_1" },
    });
    await bus.idle();
    expect(received).not.toBeNull();
    expect(received!.workflowId).toBe("wf_1");
    expect(received!.correlationId).toBe("corr_1");
    expect(received!.idempotencyKey).toBeTruthy();
    expect(received!.targetAgent).toBe("fraud-agent");
    expect(new Date(received!.occurredAt).getTime()).toBeGreaterThan(0);
  });

  it("retries failed handlers then dead-letters after max attempts", async () => {
    const bus = new MimiEventBus({ mode: "in-memory", maxAttempts: 3, retryBaseDelayMs: 1, handlerTimeoutMs: 500 });
    let attempts = 0;
    bus.subscribe("mimi.risk", () => {
      attempts += 1;
      throw new Error("boom");
    });
    await bus.publish({ topic: "mimi.risk", type: "risk.evaluation-completed", sourceAgent: "risk-agent", payload: {} });
    await bus.idle();
    // allow retry backoff timers to settle
    await new Promise((r) => setTimeout(r, 30));
    expect(attempts).toBeGreaterThanOrEqual(3);
    const dlq = bus.listDeadLetters();
    expect(dlq.length).toBe(1);
    expect(dlq[0].reason).toContain("boom");
    expect(bus.getStats().deadLetters).toBe(1);
  });

  it("replays dead-lettered events on demand", async () => {
    const bus = new MimiEventBus({ mode: "in-memory", maxAttempts: 1, retryBaseDelayMs: 1, handlerTimeoutMs: 200 });
    let fail = true;
    bus.subscribe("mimi.support", () => {
      if (fail) throw new Error("transient");
    });
    await bus.publish({ topic: "mimi.support", type: "support.followup-completed", sourceAgent: "support-agent", payload: {} });
    await bus.idle();
    expect(bus.listDeadLetters().length).toBe(1);
    fail = false;
    const ok = await bus.replayDeadLetter(bus.listDeadLetters()[0].id);
    expect(ok).toBe(true);
    await bus.idle();
    expect(bus.listDeadLetters().length).toBe(0);
  });

  it("times out hung handlers and dead-letters them", async () => {
    const bus = new MimiEventBus({ mode: "in-memory", maxAttempts: 1, handlerTimeoutMs: 20, retryBaseDelayMs: 1 });
    bus.subscribe("mimi.treasury", () => new Promise(() => undefined));
    await bus.publish({ topic: "mimi.treasury", type: "treasury.settlement-plan", sourceAgent: "treasury-agent", payload: {} });
    await bus.idle();
    await new Promise((r) => setTimeout(r, 40));
    expect(bus.listDeadLetters()[0]?.reason).toContain("handler timeout");
  }, 10_000);

  it("keeps a bounded recent-events snapshot for the UI feed", async () => {
    const bus = new MimiEventBus({ mode: "in-memory", snapshotSize: 5 });
    for (let i = 0; i < 12; i += 1) {
      await bus.publish({ topic: "mimi.audit", type: `e${i}`, sourceAgent: "system", payload: {}, idempotencyKey: `snap-${i}` });
    }
    expect(bus.recentEvents(50).length).toBe(5);
  });
});

describe("resolvePubSubTarget", () => {
  it("prefers the emulator when PUBSUB_EMULATOR_HOST is set", () => {
    const target = resolvePubSubTarget({ PUBSUB_EMULATOR_HOST: "localhost:8085", PUBSUB_PROJECT_ID: "demo" } as never);
    expect(target).toEqual({ projectId: "demo", emulator: true });
  });

  it("uses production project when only GOOGLE_CLOUD_PROJECT is set", () => {
    const target = resolvePubSubTarget({ GOOGLE_CLOUD_PROJECT: "mimi-prod" } as never);
    expect(target).toEqual({ projectId: "mimi-prod", emulator: false });
  });

  it("returns null when nothing is configured", () => {
    expect(resolvePubSubTarget({} as never)).toBeNull();
  });
});
