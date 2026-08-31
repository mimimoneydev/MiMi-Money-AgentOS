/**
 * MiMi Money AgentOS — shared domain types.
 *
 * All financial operations in MiMi Money AgentOS are SIMULATION ONLY.
 * No real-money movement ever occurs; amounts are sandbox/test values.
 */

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export const MIMI_AGENT_IDS = [
  "orchestrator",
  "payment-agent",
  "fraud-agent",
  "compliance-agent",
  "risk-agent",
  "reconciliation-agent",
  "treasury-agent",
  "support-agent",
  "reporting-agent",
  "escalation-agent",
] as const;

export type MimiAgentId = (typeof MIMI_AGENT_IDS)[number];

/** Source/target marker for events that originate from the platform itself. */
export type MimiEventActor = MimiAgentId | "system" | "operator";

export type AgentLifecycleState =
  | "IDLE"
  | "QUEUED"
  | "RUNNING"
  | "WAITING"
  | "COMPLETED"
  | "FAILED"
  | "ESCALATED"
  | "PAUSED"
  | "OFFLINE";

export interface MimiDepartment {
  id: string;
  name: string;
  mission: string;
  headAgentId: MimiAgentId;
}

export interface AgentBudget {
  /** Monthly USD spend ceiling for model + runtime usage. */
  monthlyLimitUsd: number;
  spentUsd: number;
  currency: "USD";
  hardStop: boolean;
  periodStartAt: string;
  updatedAt: string;
}

export interface AgentRuntimeInfo {
  adapter: "google-adk";
  /** ADK runner mode resolved at boot. */
  mode: AdkAdapterMode;
  /** Gemini model powering reasoning/tool selection for this agent. */
  model: string;
  /** Cloud Run service that hosts this agent's ADK worker in production. */
  cloudRunService: string;
  region: string;
}

export interface MimiAgent {
  id: MimiAgentId;
  name: string;
  title: string;
  departmentId: string;
  managerId: MimiAgentId | null;
  roleSummary: string;
  capabilities: string[];
  /** Tool names this agent may request through the Gateway. */
  permissions: string[];
  memoryScope: string[];
  runtime: AgentRuntimeInfo;
  status: AgentLifecycleState;
  heartbeatAt: string | null;
  currentWorkflowId: string | null;
  currentTask: string | null;
  stats: {
    runsTotal: number;
    runsSucceeded: number;
    runsFailed: number;
    lastRunAt: string | null;
    lastError: string | null;
  };
  budget: AgentBudget;
}

// ---------------------------------------------------------------------------
// Customers / wallets / transactions
// ---------------------------------------------------------------------------

export interface MimiCustomer {
  id: string;
  name: string;
  country: string;
  market: string;
  kycTier: "basic" | "intermediate" | "full";
  riskSegment: "retail" | "merchant" | "business";
  walletAddress: string;
  walletNetwork: string;
  createdAt: string;
  notes?: string;
}

export interface WalletEntry {
  id: string;
  customerId: string;
  direction: "credit" | "debit";
  asset: string;
  network: string;
  amountUsd: number;
  occurredAt: string;
  counterparty: string;
  txHash: string;
}

export interface MimiWalletHistory {
  customerId: string;
  entries: WalletEntry[];
  avgAmountUsd: number;
  maxAmountUsd: number;
  volume30dUsd: number;
}

export type TransactionStatus =
  | "RECEIVED"
  | "VALIDATING"
  | "SCREENING"
  | "WAITING_FOR_HUMAN"
  | "APPROVED"
  | "REJECTED"
  | "SETTLING"
  | "COMPLETED"
  | "FAILED";

export interface MimiTransaction {
  id: string;
  reference: string;
  customerId: string;
  amountUsd: number;
  asset: string;
  network: string;
  direction: "inbound" | "outbound";
  status: TransactionStatus;
  fraudRiskScore: number | null;
  complianceResult: "CLEAR" | "FLAGGED" | "BLOCKED" | "PENDING" | null;
  riskScore: number | null;
  workflowId: string | null;
  memo: string;
  createdAt: string;
  completedAt: string | null;
  sandbox: true;
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

export type WorkflowStatus =
  | "QUEUED"
  | "RUNNING"
  | "WAITING_FOR_HUMAN"
  | "COMPLETED"
  | "FAILED"
  | "ESCALATED"
  | "CANCELLED";

export type WorkflowStepStatus =
  | "IDLE"
  | "QUEUED"
  | "RUNNING"
  | "WAITING"
  | "COMPLETED"
  | "FAILED"
  | "SKIPPED";

export interface WorkflowStep {
  id: string;
  key: string;
  label: string;
  agentId: MimiAgentId;
  status: WorkflowStepStatus;
  dependsOn: string[];
  startedAt: string | null;
  completedAt: string | null;
  attempt: number;
  maxAttempts: number;
  outputSummary: string | null;
  /** Structured facts produced by authorized tool executions in this step. */
  artifacts: Record<string, unknown>;
  runId: string | null;
  error: string | null;
  order: number;
}

export interface WorkflowTraceEntry {
  at: string;
  level: "info" | "warn" | "error";
  actor: MimiEventActor;
  message: string;
  detail?: Record<string, unknown>;
}

export interface MimiWorkflow {
  id: string;
  kind: "payment";
  transactionId: string;
  status: WorkflowStatus;
  currentStepKeys: string[];
  steps: WorkflowStep[];
  trace: WorkflowTraceEntry[];
  sourceEventIdempotencyKey: string;
  humanReviewId: string | null;
  policyDecision: PolicyDecision | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  sandbox: true;
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export type PolicyEffect = "ALLOW" | "DENY" | "REQUIRE_HUMAN_APPROVAL";

export interface PolicyRule {
  id: string;
  name: string;
  description: string;
  category:
    | "transaction-threshold"
    | "fraud-risk"
    | "compliance"
    | "agent-permission"
    | "tool-authorization"
    | "rate-limit"
    | "budget"
    | "network-allowlist"
    | "sandbox-guard";
  effect: PolicyEffect;
  priority: number;
  enabled: boolean;
  params: Record<string, unknown>;
  updatedAt: string;
}

export interface PolicyEvaluationInput {
  actionType: "financial-action" | "tool-invocation" | "workflow-gate";
  toolName?: string;
  agentId?: MimiAgentId;
  amountUsd?: number;
  fraudRiskScore?: number;
  complianceResult?: string;
  sanctionedHit?: boolean;
  asset?: string;
  network?: string;
  customerKycTier?: string;
  rateWindow?: { key: string; count: number; limitPerMinute: number } | null;
  budgetExceeded?: boolean;
}

export interface PolicyDecision {
  decision: PolicyEffect;
  matchedRules: { ruleId: string; name: string; reason: string }[];
  reasons: string[];
  evaluatedAt: string;
  engine: "deterministic-v1";
}

// ---------------------------------------------------------------------------
// Human reviews
// ---------------------------------------------------------------------------

export type HumanReviewStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "CANCELLED";

export interface HumanReview {
  id: string;
  workflowId: string;
  transactionId: string;
  requestedByAgent: MimiAgentId;
  amountUsd: number;
  asset: string;
  customerId: string;
  fraudRiskScore: number;
  complianceResult: string;
  reason: string;
  policyRuleIds: string[];
  status: HumanReviewStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  expiresAt: string;
  createdAt: string;
  sandbox: true;
}

// ---------------------------------------------------------------------------
// Agent runs (ADK)
// ---------------------------------------------------------------------------

export type AdkRunStatus =
  | "QUEUED"
  | "RUNNING"
  | "AWAITING_TOOL"
  | "PAUSED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMEOUT";

/** Runtime execution modes. `remote` = official google-adk Python service. */
export type AdkAdapterMode = "gemini" | "local-simulation" | "remote";

export interface AdkToolCallRecord {
  toolName: string;
  args: Record<string, unknown>;
  gatewayDecision: PolicyEffect;
  ok: boolean;
  resultSummary: string;
  latencyMs: number;
}

export interface AdkRunSnapshot {
  runId: string;
  agentId: MimiAgentId;
  sessionId: string;
  workflowId: string | null;
  stepKey: string | null;
  status: AdkRunStatus;
  model: string;
  adapterMode: AdkAdapterMode;
  iterations: number;
  toolCalls: AdkToolCallRecord[];
  /** Structured facts extracted from authorized tool executions. */
  artifacts: Record<string, unknown>;
  outputText: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  tokenUsageEstimate: number;
  costUsdEstimate: number;
  sessionEvents: AdkSessionEvent[];
}

/** Input for creating an ADK agent run. */
export interface AdkRunInput {
  agentId: MimiAgentId;
  instruction: string;
  context: Record<string, unknown>;
  workflowId?: string | null;
  stepKey?: string | null;
  maxIterations?: number;
}

export interface AdkSessionEvent {
  at: string;
  kind: "user-message" | "model-text" | "model-tool-call" | "tool-response" | "final" | "error" | "system";
  text: string;
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Event backbone
// ---------------------------------------------------------------------------

export const MIMI_TOPICS = [
  "mimi.transactions",
  "mimi.payments",
  "mimi.fraud",
  "mimi.compliance",
  "mimi.risk",
  "mimi.reconciliation",
  "mimi.treasury",
  "mimi.support",
  "mimi.reporting",
  "mimi.lifecycle",
  "mimi.human-review",
  "mimi.audit",
  "mimi.notifications",
] as const;

export type MimiTopic = (typeof MIMI_TOPICS)[number];

export interface MimiEvent<P = Record<string, unknown>> {
  eventId: string;
  topic: MimiTopic;
  type: string;
  workflowId: string | null;
  correlationId: string;
  idempotencyKey: string;
  occurredAt: string;
  sourceAgent: MimiEventActor;
  targetAgent: MimiAgentId | null;
  payload: P;
  attempt: number;
}

export interface DeadLetterEntry {
  id: string;
  event: MimiEvent;
  reason: string;
  failedAt: string;
  attempts: number;
}

export interface EventBusPublishOptions {
  workflowId?: string | null;
  correlationId?: string;
  idempotencyKey?: string;
  targetAgent?: MimiAgentId | null;
}

export type EventHandler = (event: MimiEvent) => Promise<void> | void;

export interface EventBusStats {
  mode: "in-memory" | "google-pubsub-emulator" | "google-pubsub";
  published: number;
  delivered: number;
  duplicatesSuppressed: number;
  retries: number;
  deadLetters: number;
  topics: MimiTopic[];
  projectId: string | null;
}

// ---------------------------------------------------------------------------
// Memory bank
// ---------------------------------------------------------------------------

export const MEMORY_BANK_COLLECTIONS = [
  "agents",
  "customers",
  "wallets",
  "transactions",
  "workflows",
  "workflow_steps",
  "agent_runs",
  "agent_events",
  "policies",
  "permissions",
  "human_reviews",
  "audit",
  "notifications",
  "treasury_accounts",
  "cases",
  "reports",
] as const;

export type MemoryBankCollection = (typeof MEMORY_BANK_COLLECTIONS)[number];

/**
 * Storage contract for the MiMi Memory Bank. Implemented by
 * InMemoryMemoryBank (dev/tests) and FirestoreMemoryBank (Google Firestore).
 */
export interface MemoryBank {
  readonly mode: "in-memory" | "firestore-emulator" | "firestore";
  put<T extends { id: string }>(collection: MemoryBankCollection, doc: T): Promise<T>;
  get<T>(collection: MemoryBankCollection, id: string): Promise<T | null>;
  update<T extends { id: string }>(
    collection: MemoryBankCollection,
    id: string,
    patch: Partial<T>,
  ): Promise<T | null>;
  delete(collection: MemoryBankCollection, id: string): Promise<boolean>;
  list<T>(
    collection: MemoryBankCollection,
    opts?: { orderBy?: string; direction?: "asc" | "desc"; limit?: number },
  ): Promise<T[]>;
  count(collection: MemoryBankCollection): Promise<number>;
}

/** Structural contract consumed by services so tests can substitute fakes. */
export interface MimiEventBusContract {
  publish(
    input: {
      topic: MimiTopic;
      type: string;
      sourceAgent: MimiEventActor;
      payload: Record<string, unknown>;
    } & EventBusPublishOptions,
  ): Promise<{ event: MimiEvent | null; duplicate: boolean }>;
  subscribe(topic: MimiTopic, handler: EventHandler): () => void;
  recentEvents(limit?: number): MimiEvent[];
  listDeadLetters(): DeadLetterEntry[];
  getStats(): EventBusStats;
}

export interface MemoryBankStats {
  mode: "in-memory" | "firestore-emulator" | "firestore";
  projectId: string | null;
  collections: { name: MemoryBankCollection; documents: number }[];
  totalDocuments: number;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditRecord {
  id: string;
  at: string;
  actor: MimiEventActor;
  action: string;
  subjectType: string;
  subjectId: string | null;
  workflowId: string | null;
  outcome: "ALLOWED" | "DENIED" | "APPROVAL_REQUIRED" | "EXECUTED" | "ERROR" | "INFO";
  summary: string;
  detail: Record<string, unknown>;
  sandbox: true;
}

// ---------------------------------------------------------------------------
// Notifications & cases & reports
// ---------------------------------------------------------------------------

export interface MimiNotification {
  id: string;
  channel: "in-app" | "email" | "sms";
  recipient: string;
  subject: string;
  body: string;
  severity: "info" | "warning" | "critical";
  workflowId: string | null;
  createdAt: string;
  read: boolean;
}

export interface MimiCase {
  id: string;
  kind: "fraud" | "compliance" | "support" | "escalation" | "ops";
  title: string;
  status: "OPEN" | "IN_REVIEW" | "RESOLVED" | "CLOSED";
  severity: "low" | "medium" | "high";
  openedByAgent: MimiAgentId;
  relatedTransactionId: string | null;
  relatedCustomerId: string | null;
  summary: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface MimiReport {
  id: string;
  workflowId: string | null;
  transactionId: string | null;
  title: string;
  bodyMarkdown: string;
  generatedByAgent: MimiAgentId;
  createdAt: string;
}
