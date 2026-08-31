import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { InMemoryMemoryBank, MimiEventBus, MimiService } from "@mimi/agentos-core";
import { createMimiRouter } from "../routes/mimi-router.js";

async function buildApp() {
  const memoryBank = new InMemoryMemoryBank();
  const bus = new MimiEventBus({
    mode: "in-memory",
    sink: async (e) => void await memoryBank.put("agent_events", { ...e, id: e.eventId }),
  });
  const service = new MimiService({ memoryBank, bus, adkMode: "local-simulation" });
  await service.start();
  const app = express();
  app.use(express.json());
  app.use("/api/mimi", createMimiRouter(service));
  return { app, service };
}

describe("MiMi AgentOS HTTP surface (E2E through the Gateway + backbone)", () => {
  it("serves the seeded overview with fleet and review counts", async () => {
    const { app } = await buildApp();
    const res = await request(app).get("/api/mimi/overview");
    expect(res.status).toBe(200);
    expect(res.body.sandbox).toBe(true);
    expect(res.body.agents.total).toBe(10);
    expect(res.body.reviews.pending).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("runs the $250 demo payment to COMPLETED autonomously", async () => {
    const { app } = await buildApp();
    const post = await request(app).post("/api/mimi/demo/payment/low").send({});
    expect(post.status).toBe(200);
    const wfId = post.body.workflow.id;
    await new Promise((r) => setTimeout(r, 700));
    const wf = (await request(app).get(`/api/mimi/workflows/${wfId}`)).body;
    expect(wf.status).toBe("COMPLETED");
    expect(wf.policyDecision.decision).toBe("ALLOW");
  }, 30_000);

  it("runs the $48,500 demo payment into WAITING_FOR_HUMAN, then approves → settles", async () => {
    const { app } = await buildApp();
    const post = await request(app).post("/api/mimi/demo/payment/high").send({});
    expect(post.status).toBe(200);
    const wfId = post.body.workflow.id;
    await new Promise((r) => setTimeout(r, 800));
    let wf = (await request(app).get(`/api/mimi/workflows/${wfId}`)).body;
    expect(wf.status).toBe("WAITING_FOR_HUMAN");
    const reviewId = wf.humanReviewId as string;

    const approve = await request(app).post(`/api/mimi/reviews/${reviewId}/approve`).send({ note: "checked" });
    expect(approve.status).toBe(200);
    // double-decide is rejected
    const again = await request(app).post(`/api/mimi/reviews/${reviewId}/approve`).send({});
    expect(again.status).toBe(409);

    await new Promise((r) => setTimeout(r, 900));
    wf = (await request(app).get(`/api/mimi/workflows/${wfId}`)).body;
    expect(wf.status).toBe("COMPLETED");
  }, 40_000);

  it("rejects a pending review and closes the flow without settlement", async () => {
    const { app } = await buildApp();
    const post = await request(app).post("/api/mimi/payments/simulate").send({ amountUsd: 22_000, customerId: "cus_chidi" });
    await new Promise((r) => setTimeout(r, 800));
    const wf = (await request(app).get(`/api/mimi/workflows/${post.body.workflow.id}`)).body;
    const reject = await request(app).post(`/api/mimi/reviews/${wf.humanReviewId}/reject`).send({ note: "no" });
    expect(reject.status).toBe(200);
    await new Promise((r) => setTimeout(r, 900));
    const tx = (await request(app).get("/api/mimi/transactions")).body.transactions.find(
      (t: { id: string }) => t.id === wf.transactionId,
    );
    expect(tx.status).toBe("REJECTED");
  }, 40_000);

  it("exposes events, policies, audit, budgets, memory bank collections and system health", async () => {
    const { app } = await buildApp();
    expect((await request(app).get("/api/mimi/events?limit=10")).status).toBe(200);
    const policies = await request(app).get("/api/mimi/policies");
    expect(policies.body.policies.length).toBeGreaterThanOrEqual(8);
    const toggle = await request(app).patch("/api/mimi/policies/pol-auto-approve-max").send({ enabled: false });
    expect(toggle.body.enabled).toBe(false);
    expect((await request(app).get("/api/mimi/audit")).status).toBe(200);
    const budgets = await request(app).get("/api/mimi/budgets");
    expect(budgets.body.budgets.length).toBe(10);
    const collections = await request(app).get("/api/mimi/memory/collections");
    expect(collections.body.collections.map((c: { name: string }) => c.name)).toContain("human_reviews");
    const docs = await request(app).get("/api/mimi/memory/human_reviews");
    expect(docs.body.documents.length).toBeGreaterThanOrEqual(1);
    const system = await request(app).get("/api/mimi/system");
    expect(system.body.gateway.toolsRegistered).toBeGreaterThanOrEqual(12);
    expect(system.body.demoBanner).toContain("SANDBOX");
    const unknownCollection = await request(app).get("/api/mimi/memory/not_a_collection");
    expect(unknownCollection.status).toBe(404);
  }, 30_000);

  it("validates simulate input bounds", async () => {
    const { app } = await buildApp();
    const bad = await request(app).post("/api/mimi/payments/simulate").send({ amountUsd: -5 });
    expect(bad.status).toBe(400);
    const huge = await request(app).post("/api/mimi/payments/simulate").send({ amountUsd: 9_999_999 });
    expect(huge.status).toBe(400);
  }, 30_000);

  it("serves the MiMi Agent Gateway HTTP contract (spec §9)", async () => {
    const { app } = await buildApp();

    // POST /gateway/authorize — dry-run policy decision, never executes.
    const auth = await request(app).post("/api/mimi/gateway/authorize").send({
      agentId: "orchestrator",
      toolName: "settle-payment",
      amountUsd: 48_500,
    });
    expect(auth.status).toBe(200);
    expect(auth.body.executed).toBe(false);
    expect(auth.body.decision.decision).toBe("REQUIRE_HUMAN_APPROVAL");
    expect(auth.body.decision.matchedRules.some((m: { ruleId: string }) => m.ruleId === "pol-human-above-10k")).toBe(true);

    // POST /gateway/tool-call — full pipeline execution.
    const tool = await request(app).post("/api/mimi/gateway/tool-call").send({
      agentId: "risk-agent",
      toolName: "calculate_risk",
      args: { fraudRiskScore: 0.2, complianceResult: "CLEAR", amountUsd: 250 },
    });
    expect(tool.status).toBe(200);
    expect(tool.body.status).toBe("executed");
    expect(tool.body.result.riskScore).toBeTypeOf("number");

    // RBAC denial is surfaced, not executed.
    const denied = await request(app).post("/api/mimi/gateway/tool-call").send({
      agentId: "support-agent",
      toolName: "reconcile_transaction",
      args: { transactionId: "txn_x" },
    });
    expect(denied.status).toBe(200);
    expect(denied.body.status).toBe("denied");
    expect(denied.body.error).toContain("RBAC");

    // POST /gateway/agent-call — reporting-line delegation enforcement.
    const badDelegation = await request(app).post("/api/mimi/gateway/agent-call").send({
      fromAgentId: "support-agent",
      toAgentId: "reconciliation-agent",
      instruction: "reconcile things you should not touch",
    });
    expect(badDelegation.status).toBe(403);

    const okDelegation = await request(app).post("/api/mimi/gateway/agent-call").send({
      fromAgentId: "operator",
      toAgentId: "escalation-agent",
      instruction: "Brief the operator team on the current queue.",
      context: {},
    });
    expect(okDelegation.status).toBe(200);
    expect(okDelegation.body.run.agentId).toBe("escalation-agent");
    expect(okDelegation.body.run.status).toBe("COMPLETED");

    // GET /gateway/policies + GET /gateway/permissions
    const policies = await request(app).get("/api/mimi/gateway/policies");
    expect(policies.body.engine).toBe("deterministic-v1");
    expect(policies.body.policies.length).toBeGreaterThanOrEqual(8);
    const perms = await request(app).get("/api/mimi/gateway/permissions");
    expect(perms.body.matrix.length).toBe(10);
    const fraud = perms.body.matrix.find((m: { agentId: string }) => m.agentId === "fraud-agent");
    expect(fraud.permissions).not.toContain("reconcile_transaction");
    expect(fraud.deniedTools).toContain("send_notification");
  }, 40_000);
});
