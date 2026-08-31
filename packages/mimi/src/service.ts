import type {
  AdkRunSnapshot,
  AuditRecord,
  HumanReview,
  MimiAgent,
  MimiAgentId,
  MimiCase,
  MimiEventBusContract,
  MemoryBank,
  MemoryBankCollection,
  MimiNotification,
  MimiReport,
  MimiTransaction,
  MimiWorkflow,
  PolicyDecision,
  PolicyRule,
} from "./types.js";
import type { AgentRuntimeAdapter } from "./adk-gemini-runtime.js";
import { MEMORY_BANK_COLLECTIONS } from "./types.js";
import { MimiEventBus } from "./event-bus.js";
import { InMemoryMemoryBank } from "./memory-bank.js";
import { FirestoreMemoryBank, resolveFirestoreProjectId } from "./firestore-rest.js";
import { resolvePubSubTarget } from "./google-pubsub-rest.js";
import { PolicyEngine } from "./policy-engine.js";
import { MiMiAgentGateway } from "./gateway.js";
import { createMimiTools } from "./tools.js";
import { GoogleAdkGeminiRuntime } from "./adk-gemini-runtime.js";
import { GoogleAdkLocalSimulationRuntime } from "./adk-local-runtime.js";
import { GoogleAdkRemoteRuntime } from "./adk-remote-runtime.js";
import { PaymentOrchestrator } from "./orchestrator.js";
import { seedMemoryBank } from "./seed.js";
import { DEFAULT_GEMINI_MODEL, LIGHTWEIGHT_GEMINI_MODEL } from "./constants.js";

export type MimiAdkMode = "gemini" | "local-simulation" | "remote";

export interface MimiServiceOptions {
  memoryBank?: MemoryBank;
  bus?: MimiEventBusContract;
  adkMode?: MimiAdkMode;
  geminiModel?: string;
  seed?: boolean;
}

export interface OverviewSnapshot {
  sandbox: true;
  generatedAt: string;
  agents: {
    total: number;
    byStatus: Record<string, number>;
    healthyPct: number;
  };
  workflows: {
    running: number;
    waitingForHuman: number;
    completed: number;
    escalated: number;
    failed: number;
  };
  reviews: { pending: number; decidedToday: number };
  transactions: {
    todayCount: number;
    todayVolumeUsd: number;
    waitingForHuman: number;
    rejected: number;
    settledTotalUsd: number;
  };
  alerts: { fraudOpen: number; complianceOpen: number; opsEscalated: number; dlq: number };
  eventThroughputPerMin: number;
  autonomousActions: number;
  recentEvents: Array<{ at: string; type: string; topic: string; source: string; summary: string }>;
}

export class MimiService {
  readonly memoryBank: MemoryBank;
  readonly bus: MimiEventBusContract & { idle?(): Promise<void>; replayDeadLetter?(id: string): Promise<boolean> };
  readonly policyEngine: PolicyEngine;
  readonly gateway: MiMiAgentGateway;
  readonly runtime: AgentRuntimeAdapter;
  readonly orchestrator: PaymentOrchestrator;
  readonly adkMode: MimiAdkMode;
  readonly geminiConfigured: boolean;

  private started = false;
  private sseClients = new Set<(chunk: string) => void>();

  constructor(opts: MimiServiceOptions = {}) {
    const memoryBank =
      opts.memoryBank ??
      (resolveFirestoreProjectId()
        ? new FirestoreMemoryBank()
        : new InMemoryMemoryBank());
    const bus =
      opts.bus ??
      (new MimiEventBus({
        sink: async (event) => {
          await memoryBank.put("agent_events", { ...event, id: event.eventId });
        },
      }));
    const policyEngine = new PolicyEngine(memoryBank);
    const gateway = new MiMiAgentGateway({ memoryBank, bus, policyEngine, tools: createMimiTools(memoryBank) });

    const keyConfigured = Boolean(
      process.env.MIMI_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    );
    this.geminiConfigured = keyConfigured;
    const remoteUrl = process.env.MIMI_ADK_RUNTIME_URL?.trim() || "";
    let mode: MimiAdkMode;
    if (opts.adkMode) mode = opts.adkMode;
    else if (process.env.MIMI_ADK_MODE === "google") mode = "gemini";
    else if (process.env.MIMI_ADK_MODE === "local") mode = "local-simulation";
    else if (process.env.MIMI_ADK_MODE === "remote" || (!opts.adkMode && remoteUrl)) mode = "remote";
    else mode = keyConfigured ? "gemini" : "local-simulation";
    this.adkMode = mode;

    let runtime: AgentRuntimeAdapter;
    if (mode === "remote") {
      const remote = new GoogleAdkRemoteRuntime(memoryBank, {});
      remote.gatewayToolCallUrl =
        process.env.MIMI_GATEWAY_TOOL_CALL_URL?.trim()
        || "http://localhost:3100/api/mimi/gateway/tool-call";
      remote.gatewayToken = process.env.MIMI_GATEWAY_TOKEN?.trim() || null;
      runtime = remote;
    } else if (mode === "gemini") {
      const r = new GoogleAdkGeminiRuntime(
        memoryBank,
        {
          resolveAgent: async (id) => memoryBank.get<MimiAgent>("agents", id),
          invokeTool: async ({ agentId, toolName, args, workflowId }) => {
            const res = await gateway.invoke({ agentId: agentId as MimiAgentId, toolName, args, workflowId, skipFinancialGate: false });
            return res;
          },
        },
        { model: opts.geminiModel },
      );
      // Per-agent tool declarations are resolved lazily per run below.
      r.declarations = [];
      const origStartRun = r.startRun.bind(r);
      r.startRun = async (runId: string) => {
        const run = await r.inspectRun(runId);
        if (run) {
          const agent = await memoryBank.get<MimiAgent>("agents", run.agentId);
          if (agent) r.declarations = gateway.geminiToolDeclarationsFor(agent);
        }
        return origStartRun(runId);
      };
      runtime = r;
    } else {
      runtime = new GoogleAdkLocalSimulationRuntime(memoryBank, { gateway });
    }

    const orchestrator = new PaymentOrchestrator({
      memoryBank,
      bus,
      gateway,
      runtime,
      policyEngine,
    });

    this.memoryBank = memoryBank;
    this.bus = bus as MimiEventBusContract & { idle?(): Promise<void>; replayDeadLetter?(id: string): Promise<boolean> };
    this.policyEngine = policyEngine;
    this.gateway = gateway;
    this.runtime = runtime;
    this.orchestrator = orchestrator;
  }

  /** Seed + recovery + heartbeats. Safe to call once. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await seedMemoryBank(this.memoryBank, { runtimeMode: this.adkMode, model: this.currentModel() });
    await this.orchestrator.recoverInFlight();
    this.orchestrator.start();
    // Fan out every backbone event to SSE subscribers.
    for (const topic of ["mimi.payments", "mimi.transactions", "mimi.fraud", "mimi.compliance", "mimi.risk", "mimi.reconciliation", "mimi.treasury", "mimi.support", "mimi.reporting", "mimi.lifecycle", "mimi.human-review", "mimi.audit", "mimi.notifications"] as const) {
      this.bus.subscribe(topic, (event) => {
        this.pushSse(event);
      });
    }
  }

  shutdown(): void {
    this.orchestrator.stop();
    this.sseClients.clear();
  }

  currentModel(): string {
    return this.runtime.model || DEFAULT_GEMINI_MODEL;
  }

  addSseClient(send: (chunk: string) => void): () => void {
    this.sseClients.add(send);
    return () => this.sseClients.delete(send);
  }

  private pushSse(event: unknown): void {
    if (this.sseClients.size === 0) return;
    let payload: string;
    try {
      payload = JSON.stringify(event);
    } catch {
      return;
    }
    for (const send of this.sseClients) {
      try {
        send(`event: mimi\ndata: ${payload}\n\n`);
      } catch {
        // client gone; cleanup happens on close
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Demo operations
  // ---------------------------------------------------------------------------

  async simulatePayment(input: {
    amountUsd?: number;
    customerId?: string;
    asset?: string;
    network?: string;
    memo?: string;
    riskProfile?: "low" | "high";
    idempotencyKey?: string;
  }): Promise<{ workflow: MimiWorkflow; duplicate: boolean }> {
    const amount = input.amountUsd ?? (input.riskProfile === "high" ? 48_500 : 250);
    const customerId =
      input.customerId ?? (input.riskProfile === "high" ? "cus_chidi" : "cus_amara");
    const result = await this.orchestrator.startPaymentWorkflow({
      customerId,
      amountUsd: amount,
      asset: input.asset ?? "USDC",
      network: input.network ?? (input.riskProfile === "high" ? "polygon-amoy" : "base-sepolia"),
      memo:
        input.memo ??
        (amount >= 10_000
          ? "SIMULATED high-value USDC transfer (sandbox)"
          : "SIMULATED low-risk USDC payment (sandbox)"),
      idempotencyKey: input.idempotencyKey ?? `sim:${crypto.randomUUID()}`,
    });
    return result;
  }

  async decideReview(reviewId: string, approved: boolean, decidedBy = "operator", note?: string): Promise<HumanReview> {
    return this.orchestrator.decideReview(reviewId, approved, decidedBy, note);
  }

  async triggerRecovery(): Promise<number> {
    return this.orchestrator.recoverInFlight();
  }

  // ---------------------------------------------------------------------------
  // Read models for the UI
  // ---------------------------------------------------------------------------

  async overview(): Promise<OverviewSnapshot> {
    const [agents, workflows, reviews, transactions, cases, audit] = await Promise.all([
      this.memoryBank.list<MimiAgent>("agents", { limit: 50 }),
      this.memoryBank.list<MimiWorkflow>("workflows", { limit: 300 }),
      this.memoryBank.list<HumanReview>("human_reviews", { limit: 300 }),
      this.memoryBank.list<MimiTransaction>("transactions", { limit: 300 }),
      this.memoryBank.list<MimiCase>("cases", { limit: 100 }),
      this.memoryBank.list<AuditRecord>("audit", { limit: 300 }),
    ]);
    const dayAgo = Date.now() - 24 * 3600_000;
    const byStatus: Record<string, number> = {};
    for (const a of agents) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    const healthy = agents.filter((a) => !["FAILED", "PAUSED", "OFFLINE"].includes(a.status)).length;
    const todaysTx = transactions.filter((t) => new Date(t.createdAt).getTime() >= dayAgo);
    const recentEvents = this.bus.recentEvents(60);
    const minuteAgo = Date.now() - 60_000;
    const throughput = recentEvents.filter((e) => new Date(e.occurredAt).getTime() >= minuteAgo).length;
    return {
      sandbox: true,
      generatedAt: new Date().toISOString(),
      agents: {
        total: agents.length,
        byStatus,
        healthyPct: agents.length === 0 ? 100 : Math.round((healthy / agents.length) * 100),
      },
      workflows: {
        running: workflows.filter((w) => w.status === "RUNNING" || w.status === "QUEUED").length,
        waitingForHuman: workflows.filter((w) => w.status === "WAITING_FOR_HUMAN").length,
        completed: workflows.filter((w) => w.status === "COMPLETED").length,
        escalated: workflows.filter((w) => w.status === "ESCALATED").length,
        failed: workflows.filter((w) => w.status === "FAILED").length,
      },
      reviews: {
        pending: reviews.filter((r) => r.status === "PENDING").length,
        decidedToday: reviews.filter((r) => r.decidedAt && new Date(r.decidedAt).getTime() >= dayAgo).length,
      },
      transactions: {
        todayCount: todaysTx.length,
        todayVolumeUsd: round2(todaysTx.reduce((a, t) => a + t.amountUsd, 0)),
        waitingForHuman: transactions.filter((t) => t.status === "WAITING_FOR_HUMAN").length,
        rejected: transactions.filter((t) => t.status === "REJECTED").length,
        settledTotalUsd: round2(transactions.filter((t) => t.status === "COMPLETED").reduce((a, t) => a + t.amountUsd, 0)),
      },
      alerts: {
        fraudOpen: cases.filter((c) => c.kind === "fraud" && c.status !== "RESOLVED" && c.status !== "CLOSED").length,
        complianceOpen: cases.filter((c) => c.kind === "compliance" && c.status !== "RESOLVED" && c.status !== "CLOSED").length,
        opsEscalated: cases.filter((c) => c.kind === "ops" && c.status === "OPEN").length,
        dlq: this.bus.listDeadLetters().length,
      },
      eventThroughputPerMin: throughput,
      autonomousActions: audit.filter((a) => a.outcome === "EXECUTED").length,
      recentEvents: recentEvents.slice(0, 12).map((e) => ({
        at: e.occurredAt,
        type: e.type,
        topic: e.topic,
        source: e.sourceAgent,
        summary: summarizePayload(e.payload),
      })),
    };
  }

  fleet(): Promise<MimiAgent[]> {
    return this.memoryBank.list<MimiAgent>("agents", { limit: 50 });
  }

  async workflowDetail(id: string): Promise<(MimiWorkflow & { runs: AdkRunSnapshot[] }) | null> {
    const wf = await this.orchestrator.getWorkflow(id);
    if (!wf) return null;
    const runs = await this.runtime.listRuns({ workflowId: id });
    return { ...wf, runs };
  }

  listWorkflows(limit = 60): Promise<MimiWorkflow[]> {
    return this.orchestrator.listWorkflows({ limit });
  }

  listTransactions(limit = 100): Promise<MimiTransaction[]> {
    return this.memoryBank.list<MimiTransaction>("transactions", { limit });
  }

  listReviews(): Promise<HumanReview[]> {
    return this.memoryBank.list<HumanReview>("human_reviews", { limit: 200 });
  }

  listCases(): Promise<MimiCase[]> {
    return this.memoryBank.list<MimiCase>("cases", { limit: 100 });
  }

  listNotifications(): Promise<MimiNotification[]> {
    return this.memoryBank.list<MimiNotification>("notifications", { limit: 100 });
  }

  listReports(): Promise<MimiReport[]> {
    return this.memoryBank.list<MimiReport>("reports", { limit: 100 });
  }

  async listAudit(limit = 150): Promise<AuditRecord[]> {
    return this.memoryBank.list<AuditRecord>("audit", { limit });
  }

  async listPolicies(): Promise<Array<PolicyRule & { id: string }>> {
    return this.policyEngine.listRules();
  }

  async updatePolicy(ruleId: string, patch: { enabled?: boolean; params?: Record<string, unknown> }): Promise<PolicyRule | null> {
    if (patch.enabled !== undefined) await this.policyEngine.setRuleEnabled(ruleId, patch.enabled);
    if (patch.params) await this.policyEngine.updateRuleParams(ruleId, patch.params);
    return this.memoryBank.get<PolicyRule>("policies", ruleId);
  }

  async budgets(): Promise<Array<MimiAgent & { utilizationPct: number }>> {
    const agents = await this.fleet();
    return agents.map((a) => ({
      ...a,
      utilizationPct: Math.round(Math.min(100, (a.budget.spentUsd / Math.max(a.budget.monthlyLimitUsd, 0.000001)) * 100)),
    }));
  }

  async resetBudget(agentId: string): Promise<MimiAgent | null> {
    const agent = await this.memoryBank.get<MimiAgent>("agents", agentId);
    if (!agent) return null;
    agent.status = "IDLE";
    agent.budget.spentUsd = 0;
    agent.budget.updatedAt = new Date().toISOString();
    await this.memoryBank.put("agents", agent as unknown as Record<string, unknown> & { id: string });
    return agent;
  }

  async memoryCollections(): Promise<Array<{ name: MemoryBankCollection; documents: number | null }>> {
    if ("stats" in this.memoryBank) {
      const stats = (this.memoryBank as InMemoryMemoryBank).stats();
      return stats.collections.map((c) => ({ name: c.name, documents: c.documents < 0 ? null : c.documents }));
    }
    return MEMORY_BANK_COLLECTIONS.map((name) => ({ name, documents: null }));
  }

  async memoryCollectionDocs(collection: MemoryBankCollection, limit = 50): Promise<Array<Record<string, unknown>>> {
    assertCollection(collection);
    return this.memoryBank.list(collection, { limit });
  }

  memoryStats(): { mode: string; projectId: string | null } {
    if ("stats" in this.memoryBank) {
      const s = (this.memoryBank as InMemoryMemoryBank).stats();
      return { mode: s.mode, projectId: s.projectId };
    }
    return { mode: this.memoryBank.mode, projectId: resolveFirestoreProjectId() };
  }

  async systemHealth(): Promise<Record<string, unknown>> {
    const pubsub = resolvePubSubTarget();
    const busStats = this.bus.getStats();
    const agents = await this.fleet();
    const deadLetters = this.bus.listDeadLetters().map((d) => ({
      id: d.id,
      topic: d.event.topic,
      type: d.event.type,
      reason: d.reason,
      attempts: d.attempts,
      failedAt: d.failedAt,
    }));
    return {
      sandbox: true,
      demoBanner: "DEMO / SANDBOX MODE — no real funds are ever moved",
      controlPlane: {
        name: "MiMi Money AgentOS control plane",
        capabilities: [
          "org chart + agent registry",
          "approvals & human-in-the-loop",
          "activity log & governance",
          "budgets & cost control",
          "heartbeats",
        ],
      },
      intelligence: {
        provider: "Google Gemini",
        model: this.currentModel(),
        missionCriticalModel: process.env.MIMI_GEMINI_MISSION_MODEL?.trim() || this.currentModel(),
        lightweightModel: process.env.MIMI_GEMINI_LIGHT_MODEL?.trim() || LIGHTWEIGHT_GEMINI_MODEL,
        modalities: ["text", "image", "audio", "video"],
        adkMode: this.adkMode,
        apiKeyConfigured: this.geminiConfigured,
      },
      runtime: {
        framework: "Google ADK (Agent Development Kit) semantics",
        adapter: "AgentRuntimeAdapter",
        mode: this.adkMode,
        cloudRunServiceTemplate: process.env.MIMI_CLOUD_RUN_SERVICE_TEMPLATE?.trim() || "mimi-adk-{agent}",
        region: process.env.MIMI_CLOUD_RUN_REGION?.trim() || "africa-south1",
      },
      gateway: {
        name: "MiMi Agent Gateway",
        toolsRegistered: this.gateway.listTools().length,
        pipeline: ["identity", "rbac", "policy-engine", "human-approval", "tool", "verification", "pubsub-event", "persistence", "audit"],
      },
      pubsub: {
        configured: Boolean(pubsub),
        emulator: pubsub?.emulator ?? false,
        projectId: busStats.projectId ?? pubsub?.projectId ?? null,
        topics: busStats.topics,
        published: busStats.published,
        duplicatesSuppressed: busStats.duplicatesSuppressed,
        retries: busStats.retries,
        deadLetters: busStats.deadLetters,
      },
      memoryBank: this.memoryStats(),
      fleet: {
        total: agents.length,
        paused: agents.filter((a) => a.status === "PAUSED").length,
      },
      deadLetterQueue: deadLetters,
    };
  }

  toolCatalog(): Array<{ name: string; description: string; capabilityClass: string }> {
    return this.gateway.listTools().map((t) => ({
      name: t.name,
      description: t.description,
      capabilityClass: t.capabilityClass,
    }));
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function summarizePayload(payload: Record<string, unknown>): string {
  if (typeof payload.summary === "string") return payload.summary;
  if (typeof payload.subject === "string") return payload.subject;
  const keys = Object.keys(payload).slice(0, 3);
  return keys.map((k) => `${k}=${String(payload[k]).slice(0, 40)}`).join(", ");
}

function assertCollection(c: MemoryBankCollection): void {
  if (!MEMORY_BANK_COLLECTIONS.includes(c)) {
    throw Object.assign(new Error(`unknown collection ${c}`), { statusCode: 400 });
  }
}
