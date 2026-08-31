import type {
  MimiAgent,
  MimiDepartment,
  MimiTopic,
  PolicyRule,
} from "./types.js";

export const MIMI_SANDBOX_MODE = true;

/** Gemini model for mission-critical financial work. */
export const MISSION_CRITICAL_GEMINI_MODEL =
  process.env.MIMI_GEMINI_MISSION_MODEL?.trim()
  || process.env.MIMI_GEMINI_MODEL?.trim()
  || "gemini-3.6-flash";

/** Gemini model for lightweight support, reporting and liaison work. */
export const LIGHTWEIGHT_GEMINI_MODEL =
  process.env.MIMI_GEMINI_LIGHT_MODEL?.trim() || "gemini-3.5-flash";

/** Backwards-compatible default: mission-critical work is the safe default. */
export const DEFAULT_GEMINI_MODEL = MISSION_CRITICAL_GEMINI_MODEL;

const LIGHTWEIGHT_AGENT_IDS = new Set(["support-agent", "reporting-agent", "escalation-agent"]);

export function geminiModelForAgent(
  agentId: string,
  missionModel = MISSION_CRITICAL_GEMINI_MODEL,
  lightModel = LIGHTWEIGHT_GEMINI_MODEL,
): string {
  return LIGHTWEIGHT_AGENT_IDS.has(agentId) ? lightModel : missionModel;
}

export const MIMI_DEPARTMENTS: MimiDepartment[] = [
  {
    id: "payments-ops",
    name: "Payments Operations",
    mission: "Move value across African corridors safely, fast and fully audited.",
    headAgentId: "orchestrator",
  },
  {
    id: "risk-fraud",
    name: "Risk & Fraud Intelligence",
    mission: "Stop fraud and financial crime before value leaves the building.",
    headAgentId: "risk-agent",
  },
  {
    id: "compliance-regulatory",
    name: "Compliance & Regulatory",
    mission: "Keep every transaction inside KYC/AML and sanctions obligations.",
    headAgentId: "compliance-agent",
  },
  {
    id: "finance-treasury",
    name: "Finance & Treasury",
    mission: "Reconcile, settle and report on every sandbox dollar and cedi.",
    headAgentId: "treasury-agent",
  },
  {
    id: "customer-experience",
    name: "Customer Experience",
    mission: "Keep customers informed with human escalation one tap away.",
    headAgentId: "support-agent",
  },
];

const baseRuntime = (model: string, service: string) => ({
  adapter: "google-adk" as const,
  mode: "local-simulation" as const,
  model,
  cloudRunService: service,
  region: process.env.MIMI_CLOUD_RUN_REGION?.trim() || "africa-south1",
});

/**
 * The MiMi Money AgentOS financial AI workforce — an org chart of ten
 * specialized agents. Paperclip is only the underlying control-plane
 * framework; every agent is a Google ADK agent whose reasoning is powered by
 * Gemini, and privileged tool use always flows through the MiMi Gateway.
 */
export function buildDefaultAgents(model: string, lightModel = LIGHTWEIGHT_GEMINI_MODEL): MimiAgent[] {
  const modelFor = (agentId: string) => geminiModelForAgent(agentId, model, lightModel);
  const now = new Date().toISOString();
  const budget = (limit: number) => ({
    monthlyLimitUsd: limit,
    spentUsd: 0,
    currency: "USD" as const,
    hardStop: true,
    periodStartAt: now.slice(0, 7) + "-01T00:00:00.000Z",
    updatedAt: now,
  });

  return [
    {
      id: "orchestrator",
      name: "MiMi Orchestrator",
      title: "Head of Payments Operations",
      departmentId: "payments-ops",
      managerId: null,
      roleSummary:
        "Owns end-to-end payment workflows, sequences the specialist agents, enforces the policy gate and reports completion.",
      capabilities: ["workflow-orchestration", "agent-coordination", "policy-gate", "completion"],
      permissions: [
        "get_transaction",
        "get_customer",
        "calculate_risk",
        "request_human_approval",
        "send_notification",
        "generate_report",
        "create_case",
      ],
      memoryScope: ["workflows", "transactions", "agent_events", "audit"],
      runtime: baseRuntime(modelFor("orchestrator"), "mimi-adk-orchestrator"),
      status: "IDLE",
      heartbeatAt: now,
      currentWorkflowId: null,
      currentTask: null,
      stats: { runsTotal: 0, runsSucceeded: 0, runsFailed: 0, lastRunAt: null, lastError: null },
      budget: budget(20),
    },
    {
      id: "payment-agent",
      name: "Payment Agent",
      title: "Payments Initiator",
      departmentId: "payments-ops",
      managerId: "orchestrator",
      roleSummary:
        "Validates inbound payment instructions, normalizes amounts/assets and initiates the screening pipeline.",
      capabilities: ["payment-validation", "instruction-normalization"],
      permissions: ["get_transaction", "get_customer", "get_wallet_history", "analyze_wallet"],
      memoryScope: ["transactions", "customers", "wallets"],
      runtime: baseRuntime(modelFor("payment-agent"), "mimi-adk-payment"),
      status: "IDLE",
      heartbeatAt: now,
      currentWorkflowId: null,
      currentTask: null,
      stats: { runsTotal: 0, runsSucceeded: 0, runsFailed: 0, lastRunAt: null, lastError: null },
      budget: budget(10),
    },
    {
      id: "fraud-agent",
      name: "Fraud Agent",
      title: "Fraud Detection Analyst",
      departmentId: "risk-fraud",
      managerId: "risk-agent",
      roleSummary:
        "Scores every payment for fraud using wallet behaviour, velocity and network signals; opens fraud cases when suspicious.",
      capabilities: ["fraud-scoring", "wallet-analysis", "case-creation"],
      permissions: [
        "get_transaction",
        "get_customer",
        "get_wallet_history",
        "analyze_wallet",
        "calculate_risk",
        "create_case",
      ],
      memoryScope: ["transactions", "wallets", "cases"],
      runtime: baseRuntime(modelFor("fraud-agent"), "mimi-adk-fraud"),
      status: "IDLE",
      heartbeatAt: now,
      currentWorkflowId: null,
      currentTask: null,
      stats: { runsTotal: 0, runsSucceeded: 0, runsFailed: 0, lastRunAt: null, lastError: null },
      budget: budget(15),
    },
    {
      id: "compliance-agent",
      name: "Compliance Agent",
      title: "Regulatory Compliance Officer",
      departmentId: "compliance-regulatory",
      managerId: "orchestrator",
      roleSummary:
        "Screens customers against KYC tier, AML rules and sanctions lists; blocks non-compliant flows deterministically.",
      capabilities: ["kyc-screening", "aml-checks", "sanctions-screening"],
      permissions: ["get_transaction", "get_customer", "check_compliance", "create_case"],
      memoryScope: ["customers", "transactions", "cases", "policies"],
      runtime: baseRuntime(modelFor("compliance-agent"), "mimi-adk-compliance"),
      status: "IDLE",
      heartbeatAt: now,
      currentWorkflowId: null,
      currentTask: null,
      stats: { runsTotal: 0, runsSucceeded: 0, runsFailed: 0, lastRunAt: null, lastError: null },
      budget: budget(15),
    },
    {
      id: "risk-agent",
      name: "Risk Agent",
      title: "Head of Risk",
      departmentId: "risk-fraud",
      managerId: "orchestrator",
      roleSummary:
        "Combines fraud + compliance outputs into a single composite risk decision and recommends approve / review / decline.",
      capabilities: ["composite-risk-scoring", "decision-recommendation", "team-lead-risk"],
      permissions: ["get_transaction", "get_customer", "calculate_risk", "check_compliance"],
      memoryScope: ["transactions", "policies", "cases"],
      runtime: baseRuntime(modelFor("risk-agent"), "mimi-adk-risk"),
      status: "IDLE",
      heartbeatAt: now,
      currentWorkflowId: null,
      currentTask: null,
      stats: { runsTotal: 0, runsSucceeded: 0, runsFailed: 0, lastRunAt: null, lastError: null },
      budget: budget(15),
    },
    {
      id: "reconciliation-agent",
      name: "Reconciliation Agent",
      title: "Ledger Reconciliation Specialist",
      departmentId: "finance-treasury",
      managerId: "treasury-agent",
      roleSummary:
        "Reconciles sandbox ledger entries against settlement instructions and proves in/out balances for every workflow.",
      capabilities: ["ledger-reconciliation", "balance-proof"],
      permissions: ["get_transaction", "get_treasury_balance", "reconcile_transaction"],
      memoryScope: ["transactions", "treasury_accounts", "workflows"],
      runtime: baseRuntime(modelFor("reconciliation-agent"), "mimi-adk-reconciliation"),
      status: "IDLE",
      heartbeatAt: now,
      currentWorkflowId: null,
      currentTask: null,
      stats: { runsTotal: 0, runsSucceeded: 0, runsFailed: 0, lastRunAt: null, lastError: null },
      budget: budget(10),
    },
    {
      id: "treasury-agent",
      name: "Treasury Agent",
      title: "Treasury Manager",
      departmentId: "finance-treasury",
      managerId: "orchestrator",
      roleSummary:
        "Plans sandbox USDC settlement legs across allowed networks and monitors float and liquidity buffers.",
      capabilities: ["settlement-planning", "liquidity-monitoring"],
      permissions: ["get_treasury_balance", "reconcile_transaction", "get_transaction"],
      memoryScope: ["treasury_accounts", "transactions"],
      runtime: baseRuntime(modelFor("treasury-agent"), "mimi-adk-treasury"),
      status: "IDLE",
      heartbeatAt: now,
      currentWorkflowId: null,
      currentTask: null,
      stats: { runsTotal: 0, runsSucceeded: 0, runsFailed: 0, lastRunAt: null, lastError: null },
      budget: budget(10),
    },
    {
      id: "support-agent",
      name: "Customer Support Agent",
      title: "Customer Success Lead",
      departmentId: "customer-experience",
      managerId: "orchestrator",
      roleSummary:
        "Notifies customers at each meaningful milestone and opens support cases when humans need to step in.",
      capabilities: ["customer-notifications", "case-management"],
      permissions: ["get_transaction", "get_customer", "send_notification", "create_case"],
      memoryScope: ["notifications", "customers", "transactions", "cases"],
      runtime: baseRuntime(modelFor("support-agent"), "mimi-adk-support"),
      status: "IDLE",
      heartbeatAt: now,
      currentWorkflowId: null,
      currentTask: null,
      stats: { runsTotal: 0, runsSucceeded: 0, runsFailed: 0, lastRunAt: null, lastError: null },
      budget: budget(8),
    },
    {
      id: "reporting-agent",
      name: "Reporting Agent",
      title: "Financial Reporting Analyst",
      departmentId: "finance-treasury",
      managerId: "treasury-agent",
      roleSummary:
        "Produces audit-ready markdown reports per workflow: decisions, evidence pointers and reconciliation proof.",
      capabilities: ["report-generation", "evidence-packaging"],
      permissions: [
        "get_transaction",
        "get_customer",
        "get_treasury_balance",
        "generate_report",
      ],
      memoryScope: ["reports", "transactions", "audit"],
      runtime: baseRuntime(modelFor("reporting-agent"), "mimi-adk-reporting"),
      status: "IDLE",
      heartbeatAt: now,
      currentWorkflowId: null,
      currentTask: null,
      stats: { runsTotal: 0, runsSucceeded: 0, runsFailed: 0, lastRunAt: null, lastError: null },
      budget: budget(8),
    },
    {
      id: "escalation-agent",
      name: "Human Escalation Agent",
      title: "Escalation Liaison",
      departmentId: "customer-experience",
      managerId: "orchestrator",
      roleSummary:
        "Creates and tracks Human Review tasks in MiMi Money AgentOS, briefs operators and closes the loop after decisions.",
      capabilities: ["human-review-management", "operator-briefing", "escalation-tracking"],
      permissions: ["request_human_approval", "send_notification", "create_case", "get_transaction"],
      memoryScope: ["human_reviews", "notifications", "cases"],
      runtime: baseRuntime(modelFor("escalation-agent"), "mimi-adk-escalation"),
      status: "IDLE",
      heartbeatAt: now,
      currentWorkflowId: null,
      currentTask: null,
      stats: { runsTotal: 0, runsSucceeded: 0, runsFailed: 0, lastRunAt: null, lastError: null },
      budget: budget(8),
    },
  ];
}

/** Deterministic, seeded policy set evaluated by the Policy Engine. */
export function buildDefaultPolicies(): PolicyRule[] {
  const now = new Date().toISOString();
  return [
    {
      id: "pol-sandbox-only",
      name: "Sandbox assets only",
      description:
        "Every financial action must reference sandbox/test assets and networks. Real-money rails are structurally unreachable.",
      category: "sandbox-guard",
      effect: "DENY",
      priority: 1,
      enabled: true,
      params: {
        allowedAssets: ["USDC", "USDT", "cUSD", "NGN", "KES", "GHS"],
        allowedNetworks: ["base-sepolia", "polygon-amoy", "arbitrum-sepolia", "internal-sandbox", "celo-alfajores"],
      },
      updatedAt: now,
    },
    {
      id: "pol-auto-approve-max",
      name: "Auto-process below $1,000 low risk",
      description:
        "Payments under $1,000 USD-equivalent with composite risk < 0.40 and clear compliance are processed autonomously.",
      category: "transaction-threshold",
      effect: "ALLOW",
      priority: 10,
      enabled: true,
      params: { maxAmountUsd: 1000, maxCompositeRisk: 0.4 },
      updatedAt: now,
    },
    {
      id: "pol-human-above-10k",
      name: "Mandatory human approval ≥ $10,000",
      description:
        "Any payment at or above $10,000 USD-equivalent must wait for an explicit human approval before settlement.",
      category: "transaction-threshold",
      effect: "REQUIRE_HUMAN_APPROVAL",
      priority: 5,
      enabled: true,
      params: { minAmountUsd: 10000 },
      updatedAt: now,
    },
    {
      id: "pol-fraud-high-review",
      name: "Fraud risk ≥ 0.85 → human review",
      description:
        "Payments with fraud risk score at or above 0.85 can never complete autonomously; they enter WAITING_FOR_HUMAN.",
      category: "fraud-risk",
      effect: "REQUIRE_HUMAN_APPROVAL",
      priority: 3,
      enabled: true,
      params: { minFraudRisk: 0.85 },
      updatedAt: now,
    },
    {
      id: "pol-fraud-critical-decline",
      name: "Fraud risk ≥ 0.97 → auto-decline",
      description: "Near-certain fraud is declined automatically and escalated as a case.",
      category: "fraud-risk",
      effect: "DENY",
      priority: 2,
      enabled: true,
      params: { minFraudRisk: 0.97 },
      updatedAt: now,
    },
    {
      id: "pol-sanctions-block",
      name: "Sanctions / compliance block",
      description: "A sanctioned-entity or hard AML hit immediately denies the flow and freezes follow-up actions.",
      category: "compliance",
      effect: "DENY",
      priority: 1,
      enabled: true,
      params: {},
      updatedAt: now,
    },
    {
      id: "pol-rate-limit-tools",
      name: "Tool rate limits",
      description:
        "Each agent may invoke any single gateway tool at most N times per minute (default 60). Excess calls are denied and audited.",
      category: "rate-limit",
      effect: "DENY",
      priority: 4,
      enabled: true,
      params: { limitPerMinute: 60 },
      updatedAt: now,
    },
    {
      id: "pol-budget-hard-stop",
      name: "Budget hard stop",
      description:
        "When an agent's monthly spend reaches its cap the agent is paused and further invocations are denied until reset.",
      category: "budget",
      effect: "DENY",
      priority: 2,
      enabled: true,
      params: {},
      updatedAt: now,
    },
    {
      id: "pol-tool-rbac",
      name: "RBAC + tool authorization",
      description:
        "A tool invocation is only executed when the calling agent's permission list contains the tool AND its capability class covers it.",
      category: "tool-authorization",
      effect: "DENY",
      priority: 1,
      enabled: true,
      params: {},
      updatedAt: now,
    },
  ];
}

export const TOPIC_EVENT_TYPES: Record<MimiTopic, string[]> = {
  "mimi.payments": ["payment.received", "payment.validated", "payment.completed", "payment.rejected"],
  "mimi.transactions": ["transaction.created", "transaction.status-changed"],
  "mimi.fraud": ["fraud.analysis-requested", "fraud.analysis-completed", "fraud.case-opened"],
  "mimi.compliance": ["compliance.screening-requested", "compliance.evaluated", "compliance.blocked"],
  "mimi.risk": ["risk.evaluation-completed", "risk.gate-decision"],
  "mimi.reconciliation": ["reconciliation.requested", "reconciliation.completed", "reconciliation.break-found"],
  "mimi.treasury": ["treasury.settlement-plan", "treasury.balance-checked"],
  "mimi.support": ["support.notification-sent", "support.case-opened", "support.followup-completed"],
  "mimi.reporting": ["report.generated"],
  "mimi.lifecycle": [
    "agent.started",
    "agent.step-started",
    "agent.step-completed",
    "agent.step-failed",
    "agent.heartbeat",
    "agent.paused",
    "agent.resumed",
    "workflow.created",
    "workflow.status-changed",
    "workflow.completed",
  ],
  "mimi.human-review": [
    "human-review.requested",
    "human-review.approved",
    "human-review.rejected",
    "human-review.expired",
  ],
  "mimi.audit": ["gateway.decision", "audit.recorded"],
  "mimi.notifications": ["notification.sent"],
};
