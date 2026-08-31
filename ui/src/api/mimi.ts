import { api } from "./client";

/**
 * MiMi AgentOS API client. Mirrors the /api/mimi surface of
 * @mimi/agentos-core (server/src/routes/mimi-router.ts).
 *
 * All financial data in this client is SANDBOX / simulation only.
 */

export type WorkflowStatus =
  | "QUEUED"
  | "RUNNING"
  | "WAITING_FOR_HUMAN"
  | "COMPLETED"
  | "FAILED"
  | "ESCALATED"
  | "CANCELLED";

export type StepStatus = "IDLE" | "QUEUED" | "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | "SKIPPED";

export interface MimiAgent {
  id: string;
  name: string;
  title: string;
  departmentId: string;
  managerId: string | null;
  roleSummary: string;
  capabilities: string[];
  permissions: string[];
  memoryScope: string[];
  runtime: {
    adapter: string;
    mode: string;
    model: string;
    cloudRunService: string;
    region: string;
  };
  status: string;
  heartbeatAt: string | null;
  currentWorkflowId: string | null;
  currentTask: string | null;
  stats: { runsTotal: number; runsSucceeded: number; runsFailed: number; lastRunAt: string | null; lastError: string | null };
  budget: { monthlyLimitUsd: number; spentUsd: number; currency: string; hardStop: boolean };
}

export interface MimiWorkflowStep {
  id: string;
  key: string;
  label: string;
  agentId: string;
  status: StepStatus;
  dependsOn: string[];
  startedAt: string | null;
  completedAt: string | null;
  attempt: number;
  outputSummary: string | null;
  artifacts: Record<string, unknown>;
  error: string | null;
}

export interface MimiTraceEntry {
  at: string;
  level: "info" | "warn" | "error";
  actor: string;
  message: string;
}

export interface MimiPolicyDecision {
  decision: "ALLOW" | "DENY" | "REQUIRE_HUMAN_APPROVAL";
  matchedRules: Array<{ ruleId: string; name: string; reason: string }>;
  reasons: string[];
}

export interface MimiWorkflow {
  id: string;
  kind: string;
  transactionId: string;
  status: WorkflowStatus;
  currentStepKeys: string[];
  steps: MimiWorkflowStep[];
  trace: MimiTraceEntry[];
  humanReviewId: string | null;
  policyDecision: MimiPolicyDecision | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface MimiTransaction {
  id: string;
  reference: string;
  customerId: string;
  amountUsd: number;
  asset: string;
  network: string;
  status: string;
  fraudRiskScore: number | null;
  complianceResult: string | null;
  riskScore: number | null;
  workflowId: string | null;
  memo: string;
  createdAt: string;
  completedAt: string | null;
}

export interface MimiHumanReview {
  id: string;
  workflowId: string;
  transactionId: string;
  amountUsd: number;
  asset: string;
  customerId: string;
  fraudRiskScore: number;
  complianceResult: string;
  reason: string;
  policyRuleIds: string[];
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "CANCELLED";
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export interface MimiCase {
  id: string;
  kind: string;
  title: string;
  status: string;
  severity: string;
  openedByAgent: string;
  relatedTransactionId: string | null;
  summary: string;
  createdAt: string;
}

export interface MimiEvent {
  eventId: string;
  topic: string;
  type: string;
  workflowId: string | null;
  correlationId: string;
  idempotencyKey: string;
  occurredAt: string;
  sourceAgent: string;
  targetAgent: string | null;
  payload: Record<string, unknown>;
  attempt: number;
}

export interface DeadLetterEntry {
  id: string;
  event: MimiEvent;
  reason: string;
  attempts: number;
  failedAt: string;
}

export interface MimiOverview {
  sandbox: true;
  generatedAt: string;
  agents: { total: number; byStatus: Record<string, number>; healthyPct: number };
  workflows: { running: number; waitingForHuman: number; completed: number; escalated: number; failed: number };
  reviews: { pending: number; decidedToday: number };
  transactions: { todayCount: number; todayVolumeUsd: number; waitingForHuman: number; rejected: number; settledTotalUsd: number };
  alerts: { fraudOpen: number; complianceOpen: number; opsEscalated: number; dlq: number };
  eventThroughputPerMin: number;
  autonomousActions: number;
  recentEvents: Array<{ at: string; type: string; topic: string; source: string; summary: string }>;
}

export interface MimiPolicyRule {
  id: string;
  name: string;
  description: string;
  category: string;
  effect: "ALLOW" | "DENY" | "REQUIRE_HUMAN_APPROVAL";
  priority: number;
  enabled: boolean;
  params: Record<string, unknown>;
}

export interface MimiAuditRecord {
  id: string;
  at: string;
  actor: string;
  action: string;
  subjectType: string;
  subjectId: string | null;
  workflowId: string | null;
  outcome: string;
  summary: string;
}

export interface AdkToolCallRecord {
  toolName: string;
  gatewayDecision: string;
  ok: boolean;
  resultSummary: string;
}

export interface AdkRunSnapshot {
  runId: string;
  agentId: string;
  status: string;
  model: string;
  adapterMode: string;
  iterations: number;
  toolCalls: AdkToolCallRecord[];
  outputText: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  costUsdEstimate: number;
  stepKey: string | null;
}

export interface SystemHealth {
  sandbox: boolean;
  demoBanner: string;
  controlPlane: { name: string; capabilities: string[] };
  intelligence: {
    provider: string;
    model: string;
    missionCriticalModel: string;
    lightweightModel: string;
    modalities: string[];
    adkMode: string;
    apiKeyConfigured: boolean;
  };
  runtime: { framework: string; adapter: string; mode: string; cloudRunServiceTemplate: string; region: string };
  gateway: { name: string; toolsRegistered: number; pipeline: string[] };
  pubsub: {
    configured: boolean;
    emulator: boolean;
    projectId: string | null;
    topics: string[];
    published: number;
    duplicatesSuppressed: number;
    retries: number;
    deadLetters: number;
  };
  memoryBank: { mode: string; projectId: string | null };
  fleet: { total: number; paused: number };
  deadLetterQueue: Array<{ id: string; topic: string; type: string; reason: string; attempts: number }>;
}

const BASE = "/mimi";

export const mimiApi = {
  overview: () => api.get<MimiOverview>(`${BASE}/overview`),
  fleet: () =>
    api.get<{ sandbox: boolean; adkMode: string; model: string; agents: MimiAgent[] }>(`${BASE}/fleet`),
  agent: (agentId: string) =>
    api.get<MimiAgent & { recentRuns: AdkRunSnapshot[]; toolCatalog: Array<{ name: string; description: string; capabilityClass: string }> }>(
      `${BASE}/agents/${encodeURIComponent(agentId)}`,
    ),
  pauseAgent: (agentId: string) => api.post<{ ok: boolean }>(`${BASE}/agents/${encodeURIComponent(agentId)}/pause`, {}),
  resumeAgent: (agentId: string) => api.post<{ ok: boolean }>(`${BASE}/agents/${encodeURIComponent(agentId)}/resume`, {}),
  workflows: () => api.get<{ workflows: MimiWorkflow[] }>(`${BASE}/workflows`),
  workflow: (id: string) =>
    api.get<MimiWorkflow & { runs: AdkRunSnapshot[] }>(`${BASE}/workflows/${encodeURIComponent(id)}`),
  simulateLow: () => api.post<{ message: string; duplicated: boolean; workflow: MimiWorkflow }>(`${BASE}/demo/payment/low`, {}),
  simulateHigh: () => api.post<{ message: string; duplicated: boolean; workflow: MimiWorkflow }>(`${BASE}/demo/payment/high`, {}),
  transactions: () => api.get<{ transactions: MimiTransaction[] }>(`${BASE}/transactions`),
  events: (limit = 120) => api.get<{ events: MimiEvent[]; deadLetters: DeadLetterEntry[] }>(`${BASE}/events?limit=${limit}`),
  collections: () =>
    api.get<{ collections: Array<{ name: string; documents: number | null }>; stats: { mode: string; projectId: string | null } }>(
      `${BASE}/memory/collections`,
    ),
  collectionDocs: (name: string, limit = 50) =>
    api.get<{ collection: string; documents: Array<Record<string, unknown>> }>(`${BASE}/memory/${encodeURIComponent(name)}?limit=${limit}`),
  policies: () => api.get<{ policies: MimiPolicyRule[] }>(`${BASE}/policies`),
  updatePolicy: (ruleId: string, patch: { enabled?: boolean }) =>
    api.patch<MimiPolicyRule>(`${BASE}/policies/${encodeURIComponent(ruleId)}`, patch),
  reviews: () => api.get<{ reviews: MimiHumanReview[]; cases: MimiCase[] }>(`${BASE}/reviews`),
  approveReview: (id: string, note?: string) =>
    api.post<{ review: MimiHumanReview }>(`${BASE}/reviews/${encodeURIComponent(id)}/approve`, { note }),
  rejectReview: (id: string, note?: string) =>
    api.post<{ review: MimiHumanReview }>(`${BASE}/reviews/${encodeURIComponent(id)}/reject`, { note }),
  audit: (limit = 150) => api.get<{ audit: MimiAuditRecord[] }>(`${BASE}/audit?limit=${limit}`),
  budgets: () => api.get<{ budgets: Array<MimiAgent & { utilizationPct: number }> }>(`${BASE}/budgets`),
  resetBudget: (agentId: string) => api.post<{ ok: boolean }>(`${BASE}/budgets/${encodeURIComponent(agentId)}/reset`, {}),
  system: () => api.get<SystemHealth>(`${BASE}/system`),
  recover: () => api.post<{ recovered: number }>(`${BASE}/admin/recover`, {}),
};

/** Subscribe to the live MiMi SSE stream; returns a disposer. */
export function subscribeMimiStream(handler: (event: MimiEvent) => void): () => void {
  const source = new EventSource("/api/mimi/events/stream");
  source.addEventListener("mimi", (e) => {
    try {
      handler(JSON.parse((e as MessageEvent).data) as MimiEvent);
    } catch {
      // ignore malformed frames
    }
  });
  return () => source.close();
}
