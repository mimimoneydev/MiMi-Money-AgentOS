import { Router, type Request, type Response } from "express";
import {
  MEMORY_BANK_COLLECTIONS,
  type MemoryBankCollection,
  type MimiService,
} from "@mimi/agentos-core";

/**
 * MiMi Money AgentOS REST API + SSE stream.
 * MiMi Money AgentOS REST API, mounted by the host control plane under
 * /api/mimi (board-operator context).
 */
export function createMimiRouter(service: MimiService): Router {
  const router = Router();

  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response) => {
      fn(req, res)
        .then((result) => {
          if (!res.writableEnded) res.status(200).json(result ?? { ok: true });
        })
        .catch((err: unknown) => {
          const statusCode = (err as { statusCode?: number }).statusCode;
          if (statusCode) {
            res.status(statusCode).json({ error: err instanceof Error ? err.message : String(err) });
            return;
          }
          console.error("[mimi] route error", err);
          res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
        });
    };

  const param = (req: Request, name: string): string => {
    const v = req.params[name];
    return Array.isArray(v) ? v[0] : v;
  };

  // Overview -----------------------------------------------------------------
  router.get("/overview", wrap(async () => service.overview()));

  // Fleet / org / agents -------------------------------------------------------
  router.get("/fleet", wrap(async () => ({
    sandbox: true,
    adkMode: service.adkMode,
    model: service.currentModel(),
    agents: await service.fleet(),
  })));
  router.get("/agents/:agentId", wrap(async (req) => {
    const agent = await service.memoryBank.get("agents", param(req, "agentId"));
    if (!agent) throw Object.assign(new Error("agent not found"), { statusCode: 404 });
    const runs = await service.runtime.listRuns({ agentId: param(req, "agentId") });
    return { ...agent, recentRuns: runs.slice(0, 10), toolCatalog: service.toolCatalog() };
  }));
  router.post("/agents/:agentId/pause", wrap(async (req) => {
    const agent = await service.memoryBank.get("agents", param(req, "agentId"));
    if (!agent) throw Object.assign(new Error("agent not found"), { statusCode: 404 });
    await service.memoryBank.update<{ id: string; status: string }>("agents", param(req, "agentId"), { status: "PAUSED" });
    return { ok: true };
  }));
  router.post("/agents/:agentId/resume", wrap(async (req) => {
    const agent = await service.memoryBank.get("agents", param(req, "agentId"));
    if (!agent) throw Object.assign(new Error("agent not found"), { statusCode: 404 });
    await service.memoryBank.update<{ id: string; status: string }>("agents", param(req, "agentId"), { status: "IDLE" });
    return { ok: true };
  }));

  // Workflows --------------------------------------------------------------------
  router.get("/workflows", wrap(async () => ({ workflows: await service.listWorkflows() })));
  router.get("/workflows/:id", wrap(async (req) => {
    const wf = await service.workflowDetail(param(req, "id"));
    if (!wf) throw Object.assign(new Error("workflow not found"), { statusCode: 404 });
    return wf;
  }));

  // Demo triggers ------------------------------------------------------------------
  const simulate = (riskProfile: "low" | "high", amountUsd: number) =>
    wrap(async (req) => {
      const result = await service.simulatePayment({
        riskProfile,
        amountUsd,
        idempotencyKey: typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : undefined,
      });
      return {
        sandbox: true,
        duplicated: result.duplicate,
        workflow: result.workflow,
        message: result.duplicate
          ? "Duplicate event suppressed by idempotency — existing workflow returned"
          : `Simulated $${amountUsd.toLocaleString()} ${riskProfile}-risk payment accepted; workflow dispatched through Pub/Sub backbone`,
      };
    });
  router.post("/demo/payment/low", simulate("low", 250));
  router.post("/demo/payment/high", simulate("high", 48_500));
  router.post("/payments/simulate", wrap(async (req) => {
    const amount = Number(req.body?.amountUsd);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
      throw Object.assign(new Error("amountUsd must be a positive number ≤ 1,000,000"), { statusCode: 400 });
    }
    const result = await service.simulatePayment({
      amountUsd: amount,
      customerId: typeof req.body?.customerId === "string" ? req.body.customerId : undefined,
      asset: typeof req.body?.asset === "string" ? req.body.asset : undefined,
      network: typeof req.body?.network === "string" ? req.body.network : undefined,
      memo: typeof req.body?.memo === "string" ? req.body.memo : undefined,
      idempotencyKey: typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : undefined,
    });
    return { sandbox: true, duplicated: result.duplicate, workflow: result.workflow };
  }));

  // Transactions ----------------------------------------------------------------------
  router.get("/transactions", wrap(async () => ({ transactions: await service.listTransactions() })));

  // Events ------------------------------------------------------------------------------
  router.get("/events", wrap(async (req) => {
    const limit = Math.min(Number(req.query.limit) || 120, 500);
    return { events: service.bus.recentEvents(limit), deadLetters: service.bus.listDeadLetters() };
  }));
  router.get("/events/stream", (req: Request, res: Response) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`event: hello\ndata: {"sandbox":true}\n\n`);
    const send = (chunk: string) => res.write(chunk);
    const unsubscribe = service.addSseClient(send);
    const keepAlive = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch {
        /* closed */
      }
    }, 15_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  // Memory Bank ---------------------------------------------------------------------------
  router.get("/memory/collections", wrap(async () => ({
    collections: await service.memoryCollections(),
    stats: service.memoryStats(),
  })));
  router.get("/memory/:collection", wrap(async (req) => {
    const collection = param(req, "collection") as MemoryBankCollection;
    if (!MEMORY_BANK_COLLECTIONS.includes(collection)) {
      throw Object.assign(new Error(`unknown collection '${collection}'`), { statusCode: 404 });
    }
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    return { collection, documents: await service.memoryCollectionDocs(collection, limit) };
  }));

  // Policies ---------------------------------------------------------------------------------
  router.get("/policies", wrap(async () => ({ policies: await service.listPolicies() })));
  router.patch("/policies/:ruleId", wrap(async (req) => {
    const rule = await service.updatePolicy(param(req, "ruleId"), {
      enabled: typeof req.body?.enabled === "boolean" ? req.body.enabled : undefined,
      params: req.body?.params && typeof req.body.params === "object" ? req.body.params : undefined,
    });
    if (!rule) throw Object.assign(new Error("policy rule not found"), { statusCode: 404 });
    return rule;
  }));

  // Human reviews --------------------------------------------------------------------------------
  router.get("/reviews", wrap(async () => ({
    reviews: await service.listReviews(),
    cases: await service.listCases(),
  })));
  const decide = (approved: boolean) =>
    wrap(async (req) => {
      const review = await service.decideReview(
        param(req, "id"),
        approved,
        "operator",
        typeof req.body?.note === "string" ? req.body.note : undefined,
      );
      return { review };
    });
  router.post("/reviews/:id/approve", decide(true));
  router.post("/reviews/:id/reject", decide(false));

  // Audit ------------------------------------------------------------------------------------------
  router.get("/audit", wrap(async (req) => {
    const limit = Math.min(Number(req.query.limit) || 150, 400);
    return { audit: await service.listAudit(limit) };
  }));

  // Budgets -------------------------------------------------------------------------------------------
  router.get("/budgets", wrap(async () => ({ budgets: await service.budgets() })));
  router.post("/budgets/:agentId/reset", wrap(async (req) => {
    const agent = await service.resetBudget(param(req, "agentId"));
    if (!agent) throw Object.assign(new Error("agent not found"), { statusCode: 404 });
    return { ok: true, agent };
  }));

  // System ------------------------------------------------------------------------------------------------
  router.get("/system", wrap(async () => service.systemHealth()));
  router.get("/tools", wrap(async () => ({ tools: service.toolCatalog() })));
  router.post("/admin/recover", wrap(async () => ({ recovered: await service.triggerRecovery() })));

  // MiMi Agent Gateway — the mandatory authorization surface for agent-to-agent
  // calls, privileged tool calls and policy decisions. Every route here runs
  // the full pipeline: identity → RBAC → deterministic policy → approval →
  // execution → verification → event → persistence → audit.
  router.post("/gateway/tool-call", wrap(async (req) => {
    const body = req.body ?? {};
    if (typeof body.agentId !== "string" || typeof body.toolName !== "string") {
      throw Object.assign(new Error("agentId and toolName are required"), { statusCode: 400 });
    }
    const result = await service.gateway.invoke({
      agentId: body.agentId,
      toolName: body.toolName,
      args: typeof body.args === "object" && body.args !== null ? body.args : {},
      workflowId: typeof body.workflowId === "string" ? body.workflowId : null,
      correlationId: typeof body.correlationId === "string" ? body.correlationId : undefined,
      amountUsd: Number.isFinite(Number(body.amountUsd)) ? Number(body.amountUsd) : undefined,
      fraudRiskScore: Number.isFinite(Number(body.fraudRiskScore)) ? Number(body.fraudRiskScore) : undefined,
      complianceResult: typeof body.complianceResult === "string" ? body.complianceResult : undefined,
      asset: typeof body.asset === "string" ? body.asset : undefined,
      network: typeof body.network === "string" ? body.network : undefined,
    });
    return {
      sandbox: true,
      status: result.status,
      decision: result.decision?.decision ?? null,
      reasons: result.decision?.reasons ?? [],
      result: result.result ?? null,
      error: result.error ?? null,
      auditId: result.auditId,
      latencyMs: result.latencyMs,
    };
  }));

  router.post("/gateway/authorize", wrap(async (req) => {
    const body = req.body ?? {};
    const decision = await service.policyEngine.evaluate({
      actionType: "tool-invocation",
      toolName: typeof body.toolName === "string" ? body.toolName : undefined,
      agentId: typeof body.agentId === "string" ? body.agentId as never : undefined,
      amountUsd: Number.isFinite(Number(body.amountUsd)) ? Number(body.amountUsd) : undefined,
      fraudRiskScore: Number.isFinite(Number(body.fraudRiskScore)) ? Number(body.fraudRiskScore) : undefined,
      complianceResult: typeof body.complianceResult === "string" ? body.complianceResult : undefined,
      sanctionedHit: body.sanctionedHit === true,
      asset: typeof body.asset === "string" ? body.asset : undefined,
      network: typeof body.network === "string" ? body.network : undefined,
      rateWindow: null,
      budgetExceeded: false,
    });
    // Dry-run only: authorize never executes; record the request for audit.
    await service.gateway.writeAudit({
      actor: (typeof body.agentId === "string" ? body.agentId : "operator") as never,
      action: `gateway.authorize:${body.toolName ?? "*"}`,
      subjectType: "policy-authorization",
      subjectId: typeof body.toolName === "string" ? body.toolName : null,
      workflowId: null,
      at: new Date().toISOString(),
      outcome: decision.decision === "ALLOW" ? "ALLOWED" : decision.decision === "DENY" ? "DENIED" : "APPROVAL_REQUIRED",
      summary: decision.reasons.join("; "),
      detail: { dryRun: true, matchedRules: decision.matchedRules.map((m) => m.ruleId), sandbox: true },
    });
    return { sandbox: true, executed: false, decision };
  }));

  router.post("/gateway/agent-call", wrap(async (req) => {
    const body = req.body ?? {};
    const fromAgentId = typeof body.fromAgentId === "string" ? body.fromAgentId : "";
    const toAgentId = typeof body.toAgentId === "string" ? body.toAgentId : "";
    const instruction = typeof body.instruction === "string" && body.instruction.trim().length > 0
      ? body.instruction.trim()
      : "";
    const workflowId = typeof body.workflowId === "string" ? body.workflowId : null;
    if (!fromAgentId || !toAgentId || !instruction) {
      throw Object.assign(new Error("fromAgentId, toAgentId and instruction are required"), { statusCode: 400 });
    }

    const fleet = await service.fleet();
    const from = fleet.find((a) => a.id === fromAgentId);
    const to = fleet.find((a) => a.id === toAgentId);
    if (!to) throw Object.assign(new Error(`target agent '${toAgentId}' not found`), { statusCode: 404 });
    const denyDelegation = async (reason: string) => {
      await service.gateway.writeAudit({
        actor: (fromAgentId || "operator") as never,
        action: "gateway.agent-call",
        subjectType: "agent-delegation",
        subjectId: toAgentId,
        workflowId,
        at: new Date().toISOString(),
        outcome: "DENIED",
        summary: reason,
        detail: { sandbox: true },
      });
      throw Object.assign(new Error(reason), { statusCode: 403 });
    };

    if (fromAgentId !== "operator") {
      if (!from) throw Object.assign(new Error(`caller agent '${fromAgentId}' not found`), { statusCode: 404 });
      const isManager = to.managerId === from.id;
      const coordinates = from.capabilities.includes("agent-coordination");
      if (!isManager && !coordinates) {
        await denyDelegation(
          `delegation denied: ${from.id} may not invoke ${to.id} (not its manager and no agent-coordination capability); all delegation must flow up/down the reporting lines through the Gateway`,
        );
      }
    }
    if (["PAUSED", "OFFLINE"].includes(to.status)) {
      await denyDelegation(`target agent ${to.id} is ${to.status} and cannot accept delegated work`);
    }
    void service.bus.publish({
      topic: "mimi.lifecycle",
      type: "agent.delegation-requested",
      sourceAgent: (fromAgentId || "operator") as never,
      targetAgent: toAgentId,
      workflowId,
      idempotencyKey: `delegation:${crypto.randomUUID()}`,
      payload: { fromAgentId, toAgentId, instructionPreview: instruction.slice(0, 160), sandbox: true },
    }).catch(() => undefined);

    let run;
    try {
      run = await service.runtime.execute({
        agentId: toAgentId,
        instruction,
        context: typeof body.context === "object" && body.context !== null ? body.context : {},
        workflowId,
        stepKey: typeof body.stepKey === "string" ? body.stepKey : null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await service.gateway.writeAudit({
        actor: (fromAgentId || "operator") as never,
        action: "gateway.agent-call",
        subjectType: "agent-delegation",
        subjectId: toAgentId,
        workflowId,
        at: new Date().toISOString(),
        outcome: "ERROR",
        summary: `Delegated run to ${toAgentId} failed: ${message}`,
        detail: { sandbox: true },
      });
      throw Object.assign(new Error(`delegated run to ${toAgentId} failed: ${message}`), { statusCode: 502 });
    }
    await service.gateway.writeAudit({
      actor: (fromAgentId || "operator") as never,
      action: "gateway.agent-call",
      subjectType: "agent-delegation",
      subjectId: toAgentId,
      workflowId,
      at: new Date().toISOString(),
      outcome: run.status === "COMPLETED" ? "EXECUTED" : "ERROR",
      summary: `${fromAgentId} delegated a run to ${toAgentId} (${run.status})`,
      detail: { runId: run.runId, adapterMode: run.adapterMode, sandbox: true },
    });
    return { sandbox: true, run };
  }));

  router.get("/gateway/policies", wrap(async () => ({
    sandbox: true,
    engine: "deterministic-v1",
    policies: await service.listPolicies(),
  })));

  router.get("/gateway/permissions", wrap(async () => {
    const agents = await service.fleet();
    const tools = service.toolCatalog();
    return {
      sandbox: true,
      tools: tools.map((t) => ({ name: t.name, capabilityClass: t.capabilityClass, description: t.description })),
      matrix: agents.map((a) => ({
        agentId: a.id,
        departmentId: a.departmentId,
        managerId: a.managerId,
        permissions: a.permissions,
        capabilities: a.capabilities,
        memoryScopes: a.memoryScope,
        deniedTools: tools.map((t) => t.name).filter((n) => !a.permissions.includes(n)),
      })),
    };
  }));

  return router;
}
