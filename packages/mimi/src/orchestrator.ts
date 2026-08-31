import type {
  AdkRunInput,
  HumanReview,
  MimiAgent,
  MimiAgentId,
  MimiEventActor,
  MimiEventBusContract,
  MemoryBank,
  MimiTransaction,
  MimiWorkflow,
  PolicyDecision,
  PolicyEvaluationInput,
  WorkflowStep,
} from "./types.js";
import type { AgentRuntimeAdapter } from "./adk-gemini-runtime.js";
import { PolicyEngine } from "./policy-engine.js";
import type { MiMiAgentGateway } from "./gateway.js";

/**
 * Payment workflow orchestrator.
 *
 * Real backend state machine — every transition is persisted in the Memory
 * Bank and published to the event backbone:
 *
 *   payment.received → Payment Agent → Fraud Agent ∥ Compliance Agent →
 *   Risk Agent → deterministic Policy Gate → (Human Review when required) →
 *   Treasury Agent → Reconciliation Agent → Completion → Customer Support →
 *   Reporting
 *
 * Guarantees: idempotent workflow creation, per-workflow serialized driving,
 * step timeouts + retries + escalation, crash recovery from persisted state.
 */

const STEP_GRAPH: Array<{
  key: string;
  label: string;
  agentId: MimiAgentId;
  dependsOn: string[];
  topic:
    | "mimi.payments"
    | "mimi.fraud"
    | "mimi.compliance"
    | "mimi.risk"
    | "mimi.treasury"
    | "mimi.reconciliation"
    | "mimi.support"
    | "mimi.reporting";
}> = [
  { key: "validate", label: "Validate & initiate", agentId: "payment-agent", dependsOn: [], topic: "mimi.payments" },
  { key: "fraud", label: "Fraud analysis", agentId: "fraud-agent", dependsOn: ["validate"], topic: "mimi.fraud" },
  { key: "compliance", label: "Compliance screening", agentId: "compliance-agent", dependsOn: ["validate"], topic: "mimi.compliance" },
  { key: "risk", label: "Composite risk evaluation", agentId: "risk-agent", dependsOn: ["fraud", "compliance"], topic: "mimi.risk" },
  { key: "gate", label: "Policy gate / human approval", agentId: "orchestrator", dependsOn: ["risk"], topic: "mimi.risk" },
  { key: "settlement-plan", label: "Treasury settlement plan", agentId: "treasury-agent", dependsOn: ["gate"], topic: "mimi.treasury" },
  { key: "reconciliation", label: "Ledger reconciliation", agentId: "reconciliation-agent", dependsOn: ["settlement-plan"], topic: "mimi.reconciliation" },
  { key: "completion", label: "Complete & settle (sandbox)", agentId: "orchestrator", dependsOn: ["reconciliation"], topic: "mimi.payments" },
  { key: "support-followup", label: "Customer follow-up", agentId: "support-agent", dependsOn: ["completion"], topic: "mimi.support" },
  { key: "reporting", label: "Audit report", agentId: "reporting-agent", dependsOn: ["completion"], topic: "mimi.reporting" },
];

export interface OrchestratorOptions {
  memoryBank: MemoryBank;
  bus: MimiEventBusContract;
  gateway: MiMiAgentGateway;
  runtime: AgentRuntimeAdapter;
  policyEngine: PolicyEngine;
  now?: () => Date;
  stepTimeoutMs?: number;
  maxStepAttempts?: number;
}

export class PaymentOrchestrator {
  private readonly memoryBank: MemoryBank;
  private readonly bus: MimiEventBusContract;
  private readonly gateway: MiMiAgentGateway;
  private readonly runtime: AgentRuntimeAdapter;
  private readonly policyEngine: PolicyEngine;
  private readonly now: () => Date;
  private readonly stepTimeoutMs: number;
  private readonly maxStepAttempts: number;
  private readonly locks = new Map<string, Promise<void>>();
  private unsubscribers: Array<() => void> = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: OrchestratorOptions) {
    this.memoryBank = opts.memoryBank;
    this.bus = opts.bus;
    this.gateway = opts.gateway;
    this.runtime = opts.runtime;
    this.policyEngine = opts.policyEngine;
    this.now = opts.now ?? (() => new Date());
    this.stepTimeoutMs = opts.stepTimeoutMs ?? 90_000;
    this.maxStepAttempts = opts.maxStepAttempts ?? 3;

    // The workflow is triggered through the Pub/Sub backbone only.
    this.unsubscribers.push(
      this.bus.subscribe("mimi.payments", (event) => {
        if (event.type !== "payment.received") return;
        void this.handlePaymentReceived(event);
      }),
      this.bus.subscribe("mimi.human-review", (event) => {
        if (event.type === "human-review.approved" || event.type === "human-review.rejected") {
          void this.handleReviewDecision(event);
        }
      }),
    );
  }

  start(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      void this.pulseHeartbeats();
    }, 25_000);
    this.heartbeatTimer.unref?.();
  }

  stop(): void {
    for (const u of this.unsubscribers.splice(0)) u();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Idempotently create transaction + workflow from a payment instruction. */
  async startPaymentWorkflow(input: {
    customerId: string;
    amountUsd: number;
    asset?: string;
    network?: string;
    memo?: string;
    reference?: string;
    idempotencyKey: string;
  }): Promise<{ workflow: MimiWorkflow; duplicate: boolean }> {
    const existing = await this.findWorkflowBySourceKey(input.idempotencyKey);
    if (existing) return { workflow: existing, duplicate: true };

    const customer = await this.memoryBank.get<{ id: string }>("customers", input.customerId);
    if (!customer) throw new Error(`unknown customer ${input.customerId}`);

    const txId = `txn_${crypto.randomUUID().slice(0, 10)}`;
    const nowIso = this.now().toISOString();
    const tx: MimiTransaction = {
      id: txId,
      reference: input.reference ?? `MIMI-${nowIso.slice(0, 10).replaceAll("-", "")}-${txId.slice(-6).toUpperCase()}`,
      customerId: input.customerId,
      amountUsd: input.amountUsd,
      asset: input.asset ?? "USDC",
      network: input.network ?? "base-sepolia",
      direction: "inbound",
      status: "RECEIVED",
      fraudRiskScore: null,
      complianceResult: null,
      riskScore: null,
      workflowId: null,
      memo: input.memo ?? "",
      createdAt: nowIso,
      completedAt: null,
      sandbox: true,
    };
    await this.memoryBank.put("transactions", tx as unknown as Record<string, unknown> & { id: string });

    const steps: WorkflowStep[] = STEP_GRAPH.map((def, i) => ({
      id: `${txId}_step_${def.key}`,
      key: def.key,
      label: def.label,
      agentId: def.agentId,
      status: def.dependsOn.length === 0 ? "QUEUED" : "IDLE",
      dependsOn: def.dependsOn,
      startedAt: null,
      completedAt: null,
      attempt: 0,
      maxAttempts: this.maxStepAttempts,
      outputSummary: null,
      artifacts: {},
      runId: null,
      error: null,
      order: i,
    }));

    const workflow: MimiWorkflow = {
      id: `wf_${crypto.randomUUID().slice(0, 10)}`,
      kind: "payment",
      transactionId: txId,
      status: "QUEUED",
      currentStepKeys: [],
      steps,
      trace: [
        {
          at: nowIso,
          level: "info",
          actor: "system",
          message: `Payment received: $${input.amountUsd.toFixed(2)} ${tx.asset} on ${tx.network}`,
        },
      ],
      sourceEventIdempotencyKey: input.idempotencyKey,
      humanReviewId: null,
      policyDecision: null,
      error: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      completedAt: null,
      sandbox: true,
    };
    tx.workflowId = workflow.id;
    await this.memoryBank.put("transactions", tx as unknown as Record<string, unknown> & { id: string });
    await this.memoryBank.put("workflows", workflow as unknown as Record<string, unknown> & { id: string });

    await this.bus.publish({
      topic: "mimi.transactions",
      type: "transaction.created",
      sourceAgent: "system",
      workflowId: workflow.id,
      correlationId: workflow.id,
      idempotencyKey: `txn-created:${txId}`,
      payload: { transactionId: txId, amountUsd: tx.amountUsd, asset: tx.asset, network: tx.network, sandbox: true },
    });
    await this.bus.publish({
      topic: "mimi.lifecycle",
      type: "workflow.created",
      sourceAgent: "system",
      workflowId: workflow.id,
      correlationId: workflow.id,
      idempotencyKey: `wf-created:${workflow.id}`,
      payload: { workflowId: workflow.id, transactionId: txId, amountUsd: tx.amountUsd },
    });

    // Kick the machine through the backbone.
    await this.bus.publish({
      topic: "mimi.payments",
      type: "payment.received",
      sourceAgent: "system",
      targetAgent: "payment-agent",
      workflowId: workflow.id,
      correlationId: workflow.id,
      idempotencyKey: `payment-received:${input.idempotencyKey}`,
      payload: { transactionId: txId, customerId: input.customerId, amountUsd: tx.amountUsd, asset: tx.asset, network: tx.network },
    });
    return { workflow, duplicate: false };
  }

  /** Operator-facing decision on a Human Review task. */
  async decideReview(
    reviewId: string,
    approved: boolean,
    decidedBy: string,
    note?: string,
  ): Promise<HumanReview> {
    const review = await this.memoryBank.get<HumanReview>("human_reviews", reviewId);
    if (!review) throw new Error(`review ${reviewId} not found`);
    if (review.status !== "PENDING") throw Object.assign(new Error(`review ${reviewId} already decided`), { statusCode: 409 });
    review.status = approved ? "APPROVED" : "REJECTED";
    review.decidedBy = decidedBy;
    review.decidedAt = this.now().toISOString();
    review.decisionNote = note ?? null;
    await this.memoryBank.put("human_reviews", review as unknown as Record<string, unknown> & { id: string });
    // Resume signal flows through the backbone like everything else.
    await this.bus.publish({
      topic: "mimi.human-review",
      type: approved ? "human-review.approved" : "human-review.rejected",
      sourceAgent: "operator",
      workflowId: review.workflowId,
      correlationId: review.workflowId,
      idempotencyKey: `review-decision:${reviewId}:${approved ? "approve" : "reject"}`,
      payload: { reviewId, workflowId: review.workflowId, decidedBy, note: note ?? null },
    });
    return review;
  }

  /**
   * Crash recovery: re-drive workflows that were QUEUED/RUNNING when the
   * process died. Completed steps are skipped; RUNNING steps are reset to
   * QUEUED because their runs never finished persisting. Workflows waiting
   * for humans stay waiting — their reviews are durable.
   */
  async recoverInFlight(): Promise<number> {
    const active = (await this.memoryBank.list<MimiWorkflow>("workflows", { limit: 300 })).filter(
      (w) => w.status === "QUEUED" || w.status === "RUNNING",
    );
    for (const wf of active) {
      let mutated = false;
      for (const step of wf.steps) {
        if (step.status === "RUNNING") {
          step.status = "QUEUED";
          step.error = "reset by startup recovery";
          mutated = true;
        }
      }
      if (mutated) await this.memoryBank.put("workflows", wf as unknown as Record<string, unknown> & { id: string });
      void this.withWorkflow(wf.id, (loaded) => this.driveLoadedReal(loaded));
    }
    return active.length;
  }

  async getWorkflow(id: string): Promise<MimiWorkflow | null> {
    return this.memoryBank.get<MimiWorkflow>("workflows", id);
  }

  listWorkflows(opts: { limit?: number } = {}): Promise<MimiWorkflow[]> {
    return this.memoryBank.list<MimiWorkflow>("workflows", { limit: opts.limit ?? 100 });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async handlePaymentReceived(event: Parameters<Parameters<MimiEventBusContract["subscribe"]>[1]>[0]): Promise<void> {
    const payload = event.payload as { transactionId: string };
    const workflowId = payload.transactionId
      ? await this.workflowIdForTransaction(payload.transactionId)
      : event.workflowId;
    if (!workflowId) return;
    await this.withWorkflow(workflowId, (wf) => this.driveLoadedReal(wf));
  }

  private async workflowIdForTransaction(txId: string): Promise<string | null> {
    const wfs = await this.memoryBank.list<MimiWorkflow>("workflows", { limit: 300 });
    return wfs.find((w) => w.transactionId === txId)?.id ?? null;
  }

  private handleReviewDecision(event: Parameters<Parameters<MimiEventBusContract["subscribe"]>[1]>[0]): Promise<void> {
    const payload = event.payload as { workflowId: string; reviewId: string; decidedBy: string };
    const approved = event.type === "human-review.approved";
    return this.withWorkflow(payload.workflowId, async (wf) => {
      const gate = wf.steps.find((s) => s.key === "gate")!;
      this.trace(wf, approved ? "info" : "warn", "operator", approved
        ? `Operator approved payment after Human Review (${payload.decidedBy})`
        : `Operator rejected payment after Human Review (${payload.decidedBy})`);
      gate.artifacts.humanDecision = approved ? "APPROVED" : "REJECTED";
      gate.status = "COMPLETED";
      gate.completedAt = this.now().toISOString();
      gate.outputSummary = approved
        ? "Human approval granted; resuming settlement."
        : "Human rejected the payment; closing flow with rejection.";
      await this.touchAgent("escalation-agent", { status: "IDLE", heartbeatAt: this.now().toISOString() });
      if (wf.status === "WAITING_FOR_HUMAN") wf.status = "RUNNING";
      await this.setStatus(wf, "RUNNING");
      await this.setTransactionStatus(wf.transactionId, approved ? "APPROVED" : "REJECTED");
      await this.persist(wf);
      if (!approved) {
        // Close out gracefully: notify + report still run so the audit is complete.
        const completion = wf.steps.find((s) => s.key === "completion")!;
        completion.status = "COMPLETED";
        completion.completedAt = this.now().toISOString();
        completion.outputSummary = "Flow closed without settlement: human rejection.";
        completion.artifacts.rejectedByHuman = true;
        await this.persist(wf);
      }
      await this.driveSteps(wf);
    });
  }

  /** Serialize all state mutations per workflow against a freshly loaded doc. */
  private async withWorkflow(workflowId: string | null | undefined, fn: (wf: MimiWorkflow) => Promise<void>): Promise<void> {
    if (!workflowId) return;
    const prev = this.locks.get(workflowId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        const wf = await this.memoryBank.get<MimiWorkflow>("workflows", workflowId);
        if (!wf) return;
        await fn(wf);
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.locks.get(workflowId) === next) this.locks.delete(workflowId);
      });
    this.locks.set(workflowId, next);
    return next;
  }

  private async driveLoadedReal(wf: MimiWorkflow): Promise<void> {
    if (["COMPLETED", "FAILED", "ESCALATED", "CANCELLED"].includes(wf.status)) return;
    await this.driveSteps(wf);
  }

  private async driveSteps(wf: MimiWorkflow): Promise<void> {
    for (;;) {
      if (["COMPLETED", "FAILED", "ESCALATED", "CANCELLED"].includes(wf.status)) return;
      if (wf.status === "WAITING_FOR_HUMAN") return;

      const runnable = wf.steps.filter(
        (s) => (s.status === "IDLE" || s.status === "QUEUED") &&
          s.dependsOn.every((dep) => wf.steps.find((x) => x.key === dep)!.status === "COMPLETED"),
      );

      if (runnable.length === 0) {
        const allDone = wf.steps.every((s) => s.status === "COMPLETED" || s.status === "SKIPPED");
        if (allDone && wf.status !== "COMPLETED") {
          await this.finalizeCompleted(wf);
        }
        return;
      }

      // Parallel batch execution (e.g. fraud ∥ compliance).
      wf.currentStepKeys = runnable.map((s) => s.key);
      await this.persist(wf);
      const results = await Promise.all(runnable.map((step) => this.executeStep(wf, step)));
      const blocked = results.find((r) => r.outcome === "waiting-for-human" || r.outcome === "halted");
      if (blocked) return;
      // Reload persisted workflow before next loop iteration.
      const fresh = await this.memoryBank.get<MimiWorkflow>("workflows", wf.id);
      if (!fresh) return;
      Object.assign(wf, JSON.parse(JSON.stringify(fresh)));
    }
  }

  private async executeStep(
    wf: MimiWorkflow,
    step: WorkflowStep,
  ): Promise<{ outcome: "completed" | "waiting-for-human" | "halted" }> {
    const agent = await this.memoryBank.get<MimiAgent>("agents", step.agentId);
    step.attempt += 1;
    step.status = "RUNNING";
    step.startedAt = this.now().toISOString();
    step.error = null;
    await this.touchAgent(step.agentId, {
      status: "RUNNING",
      currentWorkflowId: wf.id,
      currentTask: step.label,
    });
    await this.publishLifecycle("agent.step-started", wf, step, {
      attempt: step.attempt,
    });
    this.trace(wf, "info", step.agentId, `${agent?.name ?? step.agentId} started: ${step.label}`);
    await this.persist(wf);

    try {
      if (step.key === "gate") {
        const outcome = await this.runPolicyGate(wf, step);
        return outcome;
      }
      if (step.key === "completion") {
        await this.runCompletion(wf, step);
        return { outcome: "completed" };
      }

      const ctx = await this.stepContext(wf);
      const run = await this.withTimeout(
        this.runtime.execute({
          agentId: step.agentId,
          instruction: this.buildInstruction(step, ctx),
          context: ctx as unknown as Record<string, unknown>,
          workflowId: wf.id,
          stepKey: step.key,
        } satisfies AdkRunInput),
        this.stepTimeoutMs,
      );
      step.runId = run.runId;
      step.artifacts = run.artifacts;
      step.outputSummary = run.outputText;
      step.status = "COMPLETED";
      step.completedAt = this.now().toISOString();

      // Surface specialist results as domain events on their own topics.
      await this.publishStepDomainEvent(wf, step);

      this.trace(wf, "info", step.agentId, `${step.label} completed — ${summarize(run.outputText)}`);
      await this.touchAgent(step.agentId, {
        status: "IDLE",
        currentWorkflowId: null,
        currentTask: null,
        heartbeatAt: this.now().toISOString(),
      });
      await this.publishLifecycle("agent.step-completed", wf, step, {});
      await this.persist(wf);
      return { outcome: "completed" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      step.error = message;
      if (step.attempt < step.maxAttempts) {
        // Retry with the same persisted step (attempt already incremented).
        step.status = "QUEUED";
        this.trace(wf, "warn", step.agentId, `${step.label} failed (attempt ${step.attempt}/${step.maxAttempts}) — retrying: ${message}`);
        await this.publishLifecycle("agent.step-failed", wf, step, { retrying: true, error: message });
        await this.touchAgent(step.agentId, { status: "IDLE", currentTask: `retry: ${step.label}` });
        await this.persist(wf);
        await sleep(30);
        return { outcome: "completed" }; // loop will re-pick it up
      }
      step.status = "FAILED";
      this.trace(wf, "error", step.agentId, `${step.label} failed permanently: ${message}`);
      await this.publishLifecycle("agent.step-failed", wf, step, { retrying: false, error: message });
      await this.escalateOperationalFailure(wf, step, message);
      return { outcome: "halted" };
    }
  }

  /** Deterministic policy application point for the payment itself. */
  private async runPolicyGate(wf: MimiWorkflow, step: WorkflowStep): Promise<{ outcome: "completed" | "waiting-for-human" | "halted" }> {
    const ctx = await this.stepContext(wf);
    const fraudArt = this.artifactOf(wf, "fraud") as { fraudRiskScore?: number } | undefined;
    const complianceArt = this.artifactOf(wf, "compliance") as { complianceResult?: string } | undefined;
    const riskArt = this.artifactOf(wf, "risk") as { riskScore?: number } | undefined;
    const fraudScore = Number(fraudArt?.fraudRiskScore ?? ctx.fraudRiskScore ?? 0);
    const complianceResult = String(complianceArt?.complianceResult ?? "CLEAR");

    const evaluationInput: PolicyEvaluationInput = {
      actionType: "financial-action",
      agentId: "orchestrator",
      toolName: "settle-payment",
      amountUsd: ctx.amountUsd,
      fraudRiskScore: fraudScore,
      complianceResult,
      sanctionedHit: complianceResult === "BLOCKED",
      asset: String(ctx.asset ?? "USDC"),
      network: String(ctx.network ?? "base-sepolia"),
      rateWindow: null,
      budgetExceeded: false,
    };
    const decision = await this.policyEngine.evaluate(evaluationInput);
    wf.policyDecision = decision;
    step.artifacts.gateDecision = decision.decision;
    step.artifacts.fraudRiskScore = fraudScore;
    step.artifacts.complianceResult = complianceResult;

    await this.bus.publish({
      topic: "mimi.risk",
      type: "risk.gate-decision",
      sourceAgent: "orchestrator",
      workflowId: wf.id,
      correlationId: wf.id,
      idempotencyKey: `gate:${wf.id}:v${step.attempt}`,
      payload: { decision: decision.decision, reasons: decision.reasons, amountUsd: ctx.amountUsd },
    });

    if (decision.decision === "DENY") {
      step.status = "COMPLETED";
      step.completedAt = this.now().toISOString();
      step.outputSummary = `Policy DENIED autonomous processing: ${decision.reasons.join("; ")}`;
      await this.setTransactionStatus(wf.transactionId, "REJECTED");
      await this.escalateAutoDecline(wf, step, decision);
      return { outcome: "halted" };
    }

    if (decision.decision === "REQUIRE_HUMAN_APPROVAL") {
      step.status = "WAITING";
      wf.status = "WAITING_FOR_HUMAN";
      const reviewId = `rev_${crypto.randomUUID().slice(0, 8)}`;
      const review: HumanReview = {
        id: reviewId,
        workflowId: wf.id,
        transactionId: wf.transactionId,
        requestedByAgent: "escalation-agent",
        amountUsd: ctx.amountUsd,
        asset: String(ctx.asset ?? "USDC"),
        customerId: ctx.customerId,
        fraudRiskScore: fraudScore,
        complianceResult,
        reason: decision.reasons.join("; "),
        policyRuleIds: decision.matchedRules.map((m) => m.ruleId),
        status: "PENDING",
        decidedBy: null,
        decidedAt: null,
        decisionNote: null,
        expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
        createdAt: this.now().toISOString(),
        sandbox: true,
      };
      wf.humanReviewId = reviewId;
      await this.memoryBank.put("human_reviews", review as unknown as Record<string, unknown> & { id: string });

      // Escalation Agent briefs the operator through Gateway-gated tools.
      const brief = await this.runtime.execute({
        agentId: "escalation-agent",
        instruction: this.buildInstruction(
          { ...STEP_GRAPH[4], key: "brief-operator" } as never,
          { ...ctx, fraudRiskScore: fraudScore, complianceResult },
        ),
        context: { ...ctx, fraudRiskScore: fraudScore, complianceResult, reviewId } as unknown as Record<string, unknown>,
        workflowId: wf.id,
        stepKey: "gate-brief",
      });
      step.runId = brief.runId;
      await this.gateway.writeAudit({
        actor: "escalation-agent",
        action: "review.requested",
        subjectType: "human-review",
        subjectId: reviewId,
        workflowId: wf.id,
        at: this.now().toISOString(),
        outcome: "INFO",
        summary: `Human review requested for $${ctx.amountUsd.toFixed(2)} — ${decision.reasons.join("; ")}`,
        detail: { policyRuleIds: review.policyRuleIds, sandbox: true },
      });
      await this.bus.publish({
        topic: "mimi.human-review",
        type: "human-review.requested",
        sourceAgent: "escalation-agent",
        workflowId: wf.id,
        correlationId: wf.id,
        idempotencyKey: `review-requested:${reviewId}`,
        payload: { reviewId, amountUsd: ctx.amountUsd, fraudRiskScore: fraudScore, reason: review.reason },
      });
      this.trace(wf, "warn", "escalation-agent", `Approval requested: workflow WAITING_FOR_HUMAN (${review.reason})`);
      await this.touchAgent("escalation-agent", { status: "WAITING", heartbeatAt: this.now().toISOString() });
      await this.setTransactionStatus(wf.transactionId, "WAITING_FOR_HUMAN");
      await this.setStatus(wf, "WAITING_FOR_HUMAN");
      await this.persist(wf);
      return { outcome: "waiting-for-human" };
    }

    // ALLOW
    step.status = "COMPLETED";
    step.completedAt = this.now().toISOString();
    step.outputSummary = `Policy ALLOWED autonomous processing: ${decision.reasons.join("; ")}`;
    this.trace(wf, "info", "orchestrator", `Policy gate allowed autonomous completion (${decision.matchedRules.map((r) => r.ruleId).join(", ") || "no constraints"})`);
    await this.persist(wf);
    return { outcome: "completed" };
  }

  private async runCompletion(wf: MimiWorkflow, step: WorkflowStep): Promise<void> {
    const rejected = step.artifacts.rejectedByHuman === true
      || (wf.steps.find((s) => s.key === "gate")!.artifacts.humanDecision === "REJECTED");
    const tx = await this.memoryBank.get<MimiTransaction>("transactions", wf.transactionId);
    if (rejected) {
      step.outputSummary = "Closed without settlement (human rejection).";
    } else {
      step.outputSummary = "Sandbox settlement applied; ledger legs balanced.";
    }
    step.status = "COMPLETED";
    step.completedAt = this.now().toISOString();
    if (tx && !rejected) {
      tx.status = "COMPLETED";
      tx.completedAt = this.now().toISOString();
      await this.memoryBank.put("transactions", tx as unknown as Record<string, unknown> & { id: string });
      await this.bus.publish({
        topic: "mimi.payments",
        type: "payment.completed",
        sourceAgent: "orchestrator",
        workflowId: wf.id,
        correlationId: wf.id,
        idempotencyKey: `payment-completed:${wf.id}`,
        payload: { transactionId: tx.id, amountUsd: tx.amountUsd, sandbox: true },
      });
    }
    await this.publishLifecycle("agent.step-completed", wf, step, {});
    this.trace(wf, "info", "orchestrator", rejected ? "Workflow closed with human rejection." : "Reconciliation completed; payment settled in sandbox.");
    await this.persist(wf);
  }

  private async finalizeCompleted(wf: MimiWorkflow): Promise<void> {
    const rejected = wf.steps.some((s) => s.artifacts?.humanDecision === "REJECTED")
      || wf.steps.find((s) => s.key === "completion")?.artifacts?.rejectedByHuman === true;
    await this.setStatus(wf, "COMPLETED");
    wf.completedAt = this.now().toISOString();
    await this.persist(wf);
    // Sweep: release any agent still bound to this finished workflow.
    const agents = await this.memoryBank.list<MimiAgent>("agents", { limit: 50 });
    for (const agent of agents) {
      if (agent.currentWorkflowId === wf.id && agent.status !== "PAUSED") {
        await this.touchAgent(agent.id, {
          status: "IDLE",
          currentWorkflowId: null,
          currentTask: null,
          heartbeatAt: this.now().toISOString(),
        });
      }
    }
    await this.bus.publish({
      topic: "mimi.lifecycle",
      type: "workflow.completed",
      sourceAgent: "system",
      workflowId: wf.id,
      correlationId: wf.id,
      idempotencyKey: `wf-completed:${wf.id}`,
      payload: { workflowId: wf.id, transactionId: wf.transactionId, outcome: rejected ? "REJECTED_BY_HUMAN" : "SETTLED" },
    });
  }

  private async escalateAutoDecline(wf: MimiWorkflow, step: WorkflowStep, decision: PolicyDecision): Promise<void> {
    const ctx = await this.stepContext(wf);
    await this.runtime.execute({
      agentId: "support-agent",
      instruction: `Notify the customer that their sandbox payment of $${ctx.amountUsd.toFixed(2)} was declined by policy: ${decision.reasons.join("; ")}. Use send_notification.`,
      context: ctx as unknown as Record<string, unknown>,
      workflowId: wf.id,
      stepKey: "decline-notify",
    }).catch(() => undefined);
    await this.markEscalated(wf, `Auto-declined by policy: ${decision.reasons.join("; ")}`, step);
  }

  private async escalateOperationalFailure(wf: MimiWorkflow, step: WorkflowStep, message: string): Promise<void> {
    await this.memoryBank.put("cases", {
      id: `case_${crypto.randomUUID().slice(0, 8)}`,
      kind: "ops",
      title: `Operational failure in ${step.label}`,
      status: "OPEN",
      severity: "high",
      openedByAgent: "orchestrator",
      relatedTransactionId: wf.transactionId,
      relatedCustomerId: null,
      summary: `Step '${step.key}' failed after ${step.attempt} attempts: ${message}`,
      createdAt: this.now().toISOString(),
      resolvedAt: null,
    } as unknown as Record<string, unknown> & { id: string });
    await this.touchAgent(step.agentId, { status: "FAILED", currentWorkflowId: null, currentTask: null });
    await this.markEscalated(wf, `Operational failure: ${message}`, step);
  }

  private async markEscalated(wf: MimiWorkflow, reason: string, step: WorkflowStep): Promise<void> {
    wf.error = reason;
    step.error = step.error ?? reason;
    await this.setStatus(wf, "ESCALATED");
    this.trace(wf, "error", "orchestrator", reason);
    // Release agents still bound to this workflow.
    const agents = await this.memoryBank.list<MimiAgent>("agents", { limit: 50 });
    for (const agent of agents) {
      if (agent.currentWorkflowId === wf.id && agent.status !== "PAUSED") {
        await this.touchAgent(agent.id, { status: "IDLE", currentWorkflowId: null, currentTask: null });
      }
    }
    await this.gateway.writeAudit({
      actor: "orchestrator",
      action: "workflow.escalated",
      subjectType: "workflow",
      subjectId: wf.id,
      workflowId: wf.id,
      at: this.now().toISOString(),
      outcome: "ERROR",
      summary: reason,
      detail: { sandbox: true },
    });
    await this.bus.publish({
      topic: "mimi.notifications",
      type: "notification.sent",
      sourceAgent: "orchestrator",
      workflowId: wf.id,
      correlationId: wf.id,
      idempotencyKey: `escalated:${wf.id}:${step.attempt}`,
      payload: { severity: "critical", subject: "Workflow escalated", body: reason },
    });
    await this.persist(wf);
  }

  private async stepContext(wf: MimiWorkflow): Promise<{
    transactionId: string;
    customerId: string;
    amountUsd: number;
    asset: string;
    network: string;
    fraudRiskScore?: number;
    complianceResult?: string;
    riskScore?: number;
  }> {
    const tx = await this.memoryBank.get<MimiTransaction>("transactions", wf.transactionId);
    const base: Record<string, unknown> = {};
    for (const step of wf.steps) {
      if (step.artifacts && Object.keys(step.artifacts).length > 0) {
        base[`${step.key}Result`] = JSON.parse(JSON.stringify(step.artifacts));
      }
    }
    return {
      transactionId: wf.transactionId,
      customerId: tx?.customerId ?? "",
      amountUsd: tx?.amountUsd ?? 0,
      asset: tx?.asset ?? "USDC",
      network: tx?.network ?? "base-sepolia",
      ...base,
    } as never;
  }

  private buildInstruction(step: { key: string; label: string; agentId: MimiAgentId }, ctx: Record<string, unknown>): string {
    const facts = Object.entries(ctx)
      .filter(([k]) => !k.endsWith("Result"))
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
      .join(", ");
    switch (step.agentId) {
      case "payment-agent":
        return `Validate inbound payment instruction (transactionId=${ctx.transactionId}). Fetch the transaction and the customer, confirm the instruction is well-formed, then summarize.`;
      case "fraud-agent":
        return `Assess fraud risk for transaction ${ctx.transactionId}: analyze the customer's wallet behaviour for amount $${ctx.amountUsd}. Report the score and dominant factors.`;
      case "compliance-agent":
        return `Screen transaction ${ctx.transactionId} for KYC/AML/sanctions compliance (customer ${ctx.customerId}, amount $${ctx.amountUsd}). Report CLEAR/FLAGGED/BLOCKED with the reason.`;
      case "risk-agent":
        return `Compute composite risk for transaction ${ctx.transactionId} using the fraud score and compliance result gathered earlier, then recommend proceed/review/decline per policy thresholds.`;
      case "treasury-agent":
        return `Plan the sandbox USDC settlement leg for transaction ${ctx.transactionId} ($${ctx.amountUsd}). Check treasury balances and pick the route with sufficient float.`;
      case "reconciliation-agent":
        return `Reconcile transaction ${ctx.transactionId}: prove debit/credit ledger legs balance in the sandbox ledger.`;
      case "support-agent":
        return `Send the customer a milestone notification about transaction ${ctx.transactionId} using send_notification.`;
      case "escalation-agent":
        return `Brief the operator: a Human Review task (${ctx.reviewId ?? ""}) needs attention for transaction ${ctx.transactionId}, amount $${ctx.amountUsd}, fraud risk ${ctx.fraudRiskScore}. Send an operator notification.`;
      case "reporting-agent":
        return `Generate the audit-ready markdown report for workflow ${ctx.transactionId} using generate_report. Include decision summary and evidence pointers. No hidden reasoning.`;
      default:
        return `Perform your duty (${step.label}) for transaction ${ctx.transactionId}. Facts: ${facts}`;
    }
  }

  private artifactOf(wf: MimiWorkflow, key: string): Record<string, unknown> | undefined {
    return wf.steps.find((s) => s.key === key)?.artifacts;
  }

  private publishStepDomainEvent(wf: MimiWorkflow, step: WorkflowStep): Promise<void> {
    const graphDef = STEP_GRAPH.find((d) => d.key === step.key)!;
    return this.bus.publish({
      topic: graphDef.topic,
      type: stepDomainEventType(step),
      sourceAgent: step.agentId,
      workflowId: wf.id,
      correlationId: wf.id,
      idempotencyKey: `step-done:${wf.id}:${step.key}:a${step.attempt}`,
      payload: {
        stepKey: step.key,
        summary: step.outputSummary,
        artifacts: sanitizeArtifacts(step.artifacts),
      },
    }).then(() => undefined);
  }

  private publishLifecycle(type: string, wf: MimiWorkflow, step: WorkflowStep, extra: Record<string, unknown>): Promise<void> {
    return this.bus.publish({
      topic: "mimi.lifecycle",
      type,
      sourceAgent: step.agentId,
      workflowId: wf.id,
      correlationId: wf.id,
      idempotencyKey: `${type}:${wf.id}:${step.key}:${step.attempt}:${step.status}`,
      payload: { stepKey: step.key, label: step.label, status: step.status, ...extra },
    }).then(() => undefined);
  }

  private trace(wf: MimiWorkflow, level: "info" | "warn" | "error", actor: MimiEventActor, message: string): void {
    wf.trace.push({ at: this.now().toISOString(), level, actor, message });
    if (wf.trace.length > 200) wf.trace.shift();
  }

  private async setStatus(wf: MimiWorkflow, status: MimiWorkflow["status"]): Promise<void> {
    if (wf.status !== status) {
      wf.status = status;
      await this.bus.publish({
        topic: "mimi.transactions",
        type: "transaction.status-changed",
        sourceAgent: "system",
        workflowId: wf.id,
        correlationId: wf.id,
        idempotencyKey: `wf-status:${wf.id}:${status}`,
        payload: { workflowId: wf.id, status },
      }).catch(() => undefined);
    }
    wf.updatedAt = this.now().toISOString();
  }

  private async setTransactionStatus(txId: string, status: MimiTransaction["status"]): Promise<void> {
    const tx = await this.memoryBank.get<MimiTransaction>("transactions", txId);
    if (!tx) return;
    tx.status = status;
    await this.memoryBank.put("transactions", tx as unknown as Record<string, unknown> & { id: string });
  }

  private async touchAgent(agentId: MimiAgentId, patch: Partial<MimiAgent>): Promise<void> {
    await this.memoryBank.update<MimiAgent>("agents", agentId, patch);
  }

  private async persist(wf: MimiWorkflow): Promise<void> {
    wf.updatedAt = this.now().toISOString();
    await this.memoryBank.put("workflows", JSON.parse(JSON.stringify(wf)) as unknown as Record<string, unknown> & { id: string });
  }

  private async findWorkflowBySourceKey(key: string): Promise<MimiWorkflow | null> {
    const rows = await this.memoryBank.list<MimiWorkflow>("workflows", { limit: 300 });
    return rows.find((w) => w.sourceEventIdempotencyKey === key) ?? null;
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`step timeout after ${ms}ms`)), ms);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }

  private async pulseHeartbeats(): Promise<void> {
    const agents = await this.memoryBank.list<MimiAgent>("agents", { limit: 50 });
    for (const agent of agents) {
      if (agent.status === "PAUSED" || agent.status === "OFFLINE") continue;
      await this.memoryBank.update<MimiAgent>("agents", agent.id, { heartbeatAt: this.now().toISOString() });
      await this.bus.publish({
        topic: "mimi.lifecycle",
        type: "agent.heartbeat",
        sourceAgent: agent.id,
        payload: { agentId: agent.id, status: agent.status },
      }).catch(() => undefined);
    }
  }
}

function stepDomainEventType(step: WorkflowStep): string {
  switch (step.key) {
    case "validate": return "payment.validated";
    case "fraud": return "fraud.analysis-completed";
    case "compliance": return "compliance.evaluated";
    case "risk": return "risk.evaluation-completed";
    case "gate": return "risk.gate-decision";
    case "settlement-plan": return "treasury.settlement-plan";
    case "reconciliation": return "reconciliation.completed";
    case "completion": return "payment.completed";
    case "support-followup": return "support.followup-completed";
    case "reporting": return "report.generated";
    default: return "lifecycle.step";
  }
}

function sanitizeArtifacts(artifacts: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!artifacts) return {};
  const clone = JSON.parse(JSON.stringify(artifacts));
  delete (clone as Record<string, unknown>).reasoning;
  return clone;
}

function summarize(text: string | null): string {
  if (!text) return "(silent)";
  return text.length > 160 ? text.slice(0, 157) + "…" : text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
