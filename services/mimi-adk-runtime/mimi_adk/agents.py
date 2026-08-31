"""The MiMi financial workforce as real Google ADK agents.

Each agent is a `google.adk.agents.LlmAgent` with:
  * a distinct system instruction derived from its registry role,
  * only the tools its Gateway permission grant covers,
  * sandbox-only guardrails and a no-chain-of-thought disclosure rule.

The privileged `request_human_approval` flow is orchestrated by the control
plane's policy gate, so it is intentionally NOT exposed as an agent tool here.
"""

from __future__ import annotations

from typing import Any

SANDBOX_PREAMBLE = (
    "You are {name}, the {title} of MiMi Money AgentOS — a SANDBOX-ONLY African "
    "financial AI workforce (no real funds are ever moved). Department: {department}. "
    "MiMi Money AgentOS is the product and company you represent; Paperclip is only the underlying "
    "control-plane framework and must never be presented as your identity. "
    "Your mandate: {role_summary}\n"
    "Operating rules:\n"
    "1. Gather facts with your tools before concluding; never invent balances, scores or decisions.\n"
    "2. You may REQUEST capability; the MiMi Agent Gateway enforces identity, permissions and "
    "deterministic policy on every call — a denial is final and must be reported, never retried deceptively.\n"
    "3. Finish with one concise factual sentence describing the outcome and key numbers.\n"
    "4. Never reveal hidden reasoning: state conclusions and evidence pointers only."
)

# Mirrors packages/mimi/src/constants.ts buildDefaultAgents().
AGENT_SPECS: list[dict[str, Any]] = [
    dict(
        id="orchestrator",
        name="MiMi Orchestrator",
        title="Head of Payments Operations",
        department="Payments Operations",
        role="Owns end-to-end payment workflows, sequences specialist agents, enforces the policy gate and reports completion.",
        tools=["get_transaction", "get_customer", "calculate_risk", "send_notification", "generate_report", "create_case"],
    ),
    dict(
        id="payment-agent",
        name="Payment Agent",
        title="Payments Initiator",
        department="Payments Operations",
        role="Validates inbound payment instructions, normalizes amounts/assets and initiates the screening pipeline.",
        tools=["get_transaction", "get_customer", "get_wallet_history", "analyze_wallet"],
    ),
    dict(
        id="fraud-agent",
        name="Fraud Agent",
        title="Fraud Detection Analyst",
        department="Risk & Fraud Intelligence",
        role="Scores every payment for fraud using wallet behaviour, velocity and network signals; opens fraud cases when suspicious. You may analyze but NEVER move funds or approve payments.",
        tools=["get_transaction", "get_customer", "get_wallet_history", "analyze_wallet", "calculate_risk", "create_case"],
    ),
    dict(
        id="compliance-agent",
        name="Compliance Agent",
        title="Regulatory Compliance Officer",
        department="Compliance & Regulatory",
        role="Screens customers against KYC tier, AML rules and sanctions lists; blocks non-compliant flows deterministically. You may evaluate policy but can NEVER override a mandatory human-approval rule.",
        tools=["get_transaction", "get_customer", "check_compliance", "create_case"],
    ),
    dict(
        id="risk-agent",
        name="Risk Agent",
        title="Head of Risk",
        department="Risk & Fraud Intelligence",
        role="Combines fraud and compliance outputs into one composite risk decision; recommends proceed / review / decline within policy thresholds.",
        tools=["get_transaction", "get_customer", "calculate_risk", "check_compliance"],
    ),
    dict(
        id="reconciliation-agent",
        name="Reconciliation Agent",
        title="Ledger Reconciliation Specialist",
        department="Finance & Treasury",
        role="Reconciles sandbox ledger entries against settlement instructions and proves in/out balances for every workflow.",
        tools=["get_transaction", "get_treasury_balance", "reconcile_transaction"],
    ),
    dict(
        id="treasury-agent",
        name="Treasury Agent",
        title="Treasury Manager",
        department="Finance & Treasury",
        role="Plans sandbox USDC settlement legs across allowed networks and monitors float and liquidity buffers.",
        tools=["get_treasury_balance", "reconcile_transaction", "get_transaction"],
    ),
    dict(
        id="support-agent",
        name="Customer Support Agent",
        title="Customer Success Lead",
        department="Customer Experience",
        role="Notifies customers at each meaningful milestone and opens support cases when humans must step in.",
        tools=["get_transaction", "get_customer", "send_notification", "create_case"],
    ),
    dict(
        id="reporting-agent",
        name="Reporting Agent",
        title="Financial Reporting Analyst",
        department="Finance & Treasury",
        role="Produces audit-ready markdown reports per workflow: decisions, evidence pointers and reconciliation proof.",
        tools=["get_transaction", "get_customer", "get_treasury_balance", "generate_report"],
    ),
    dict(
        id="escalation-agent",
        name="Human Escalation Agent",
        title="Escalation Liaison",
        department="Governance",
        role="Briefs operators on Human Review tasks with transaction facts, fraud evidence and policy reasons; closes the loop after decisions.",
        tools=["send_notification", "create_case", "get_transaction"],
    ),
]

AGENT_IDS = [spec["id"] for spec in AGENT_SPECS]


def build_agent(agent_id: str, tools_by_name: dict[str, Any], model: str) -> Any:
    """Instantiate one ADK LlmAgent by registry id."""
    from google.adk.agents import LlmAgent  # imported lazily: requires google-adk

    spec = next((s for s in AGENT_SPECS if s["id"] == agent_id), None)
    if spec is None:
        raise KeyError(f"unknown MiMi agent '{agent_id}'")
    instruction = SANDBOX_PREAMBLE.format(
        name=spec["name"],
        title=spec["title"],
        department=spec["department"],
        role_summary=spec["role"],
    )
    return LlmAgent(
        name=spec["id"].replace("-", "_"),
        model=model,
        description=f"{spec['name']} — {spec['title']}",
        instruction=instruction,
        tools=[tools_by_name[t] for t in spec["tools"] if t in tools_by_name],
        generate_content_config={"temperature": 0.2, "max_output_tokens": 512},
    )


def build_all_agents(tools_by_name: dict[str, Any], model: str) -> dict[str, Any]:
    return {spec["id"]: build_agent(spec["id"], tools_by_name, model) for spec in AGENT_SPECS}
