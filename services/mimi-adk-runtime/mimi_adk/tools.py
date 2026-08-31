"""ADK function tools for the MiMi financial workforce.

Each tool is a plain, docstring-annotated async function (google-adk wraps
them as FunctionTools for Gemini function calling) that forwards the call to
the MiMi Agent Gateway. Tool functions receive an optional `tool_context`
whose state carries the run-scoped recorder (agent id, workflow id and the
toolCalls list), installed by the runner in `service.py`.
"""

from __future__ import annotations

import json
import time
from typing import Any, Optional

from .gateway import GatewayClient


def _recorder(tool_context: Any) -> dict[str, Any]:
    """Run-scoped state installed before the Runner starts."""
    return getattr(tool_context, "state", {}) or {}


async def _call_gateway(
    tool_name: str,
    tool_context: Any,
    gateway: GatewayClient,
    **kwargs: Any,
) -> dict[str, Any]:
    state = _recorder(tool_context)
    agent_id = str(state.get("agentId", "orchestrator"))
    workflow_id = Optional[state.get("workflowId")]  # noqa: F841 — clarity
    started = time.monotonic()
    result, error = await gateway.invoke_tool(
        agent_id=agent_id,
        tool_name=tool_name,
        args={k: v for k, v in kwargs.items() if v is not None},
        workflow_id=state.get("workflowId"),
        correlation_id=state.get("correlationId"),
    )
    latency_ms = int((time.monotonic() - started) * 1000)
    calls: list[dict[str, Any]] = state.setdefault("toolCalls", [])
    calls.append(
        {
            "toolName": tool_name,
            "args": {k: v for k, v in kwargs.items() if v is not None},
            "gatewayDecision": "DENY" if error else "ALLOW",
            "ok": error is None,
            "resultSummary": (error or json.dumps(result, default=str))[:400],
            "latencyMs": latency_ms,
        }
    )
    if error is not None:
        # The model sees the denial and can adapt; it can NEVER bypass it.
        return {"ok": False, "error": error, "sandbox": True}
    return {"ok": True, "result": result, "sandbox": True}


def build_tools(gateway: GatewayClient) -> list[Any]:
    """Construct the 12 MiMi financial tools bound to one gateway client."""

    async def get_transaction(transactionId: str, tool_context: Any = None) -> dict:
        """Fetch a sandbox transaction by id.

        Args:
            transactionId: The sandbox transaction identifier.
            tool_context: Injected ADK runtime context.
        """
        return await _call_gateway("get_transaction", tool_context, gateway, transactionId=transactionId)

    async def get_customer(customerId: str, tool_context: Any = None) -> dict:
        """Fetch a MiMi customer profile by id.

        Args:
            customerId: The sandbox customer identifier.
            tool_context: Injected ADK runtime context.
        """
        return await _call_gateway("get_customer", tool_context, gateway, customerId=customerId)

    async def get_wallet_history(customerId: str, tool_context: Any = None) -> dict:
        """Fetch a customer's wallet movement history with aggregates.

        Args:
            customerId: The sandbox customer identifier.
            tool_context: Injected ADK runtime context.
        """
        return await _call_gateway("get_wallet_history", tool_context, gateway, customerId=customerId)

    async def analyze_wallet(customerId: str, amountUsd: float, tool_context: Any = None) -> dict:
        """Run deterministic wallet-behaviour fraud analytics; returns fraudRiskScore plus contributing factors.

        Args:
            customerId: The customer whose wallet behaviour is analyzed.
            amountUsd: Proposed payment amount in USD-equivalent.
            tool_context: Injected ADK runtime context.
        """
        return await _call_gateway(
            "analyze_wallet", tool_context, gateway, customerId=customerId, amountUsd=amountUsd
        )

    async def calculate_risk(fraudRiskScore: float, complianceResult: str, amountUsd: float, tool_context: Any = None) -> dict:
        """Compute the composite risk score from fraud score, compliance outcome and amount.

        Args:
            fraudRiskScore: Wallet/fraud risk in [0,1].
            complianceResult: CLEAR, FLAGGED or BLOCKED.
            amountUsd: USD-equivalent amount.
            tool_context: Injected ADK runtime context.
        """
        return await _call_gateway(
            "calculate_risk",
            tool_context,
            gateway,
            fraudRiskScore=fraudRiskScore,
            complianceResult=complianceResult,
            amountUsd=amountUsd,
        )

    async def check_compliance(customerId: str, amountUsd: float, walletAddress: Optional[str] = None, tool_context: Any = None) -> dict:
        """Screen a customer and payment against KYC tier, AML thresholds and sanctions lists.

        Args:
            customerId: Customer to screen.
            amountUsd: USD-equivalent amount.
            walletAddress: Optional counterparty address to screen.
            tool_context: Injected ADK runtime context.
        """
        return await _call_gateway(
            "check_compliance",
            tool_context,
            gateway,
            customerId=customerId,
            amountUsd=amountUsd,
            walletAddress=walletAddress,
        )

    async def reconcile_transaction(transactionId: str, tool_context: Any = None) -> dict:
        """Prove sandbox ledger balance for a transaction (privileged; policy-gated).

        Args:
            transactionId: Transaction to reconcile.
            tool_context: Injected ADK runtime context.
        """
        return await _call_gateway("reconcile_transaction", tool_context, gateway, transactionId=transactionId)

    async def get_treasury_balance(network: Optional[str] = None, tool_context: Any = None) -> dict:
        """Read sandbox treasury balances, optionally filtered by network.

        Args:
            network: Optional network filter such as base-sepolia.
            tool_context: Injected ADK runtime context.
        """
        return await _call_gateway("get_treasury_balance", tool_context, gateway, network=network)

    async def create_case(kind: str, title: str, summary: str, severity: str, relatedTransactionId: Optional[str] = None, relatedCustomerId: Optional[str] = None, tool_context: Any = None) -> dict:
        """Open an investigation or support case (fraud/compliance/support/escalation/ops).

        Args:
            kind: Case kind.
            title: Short case title.
            summary: Case summary with evidence pointers.
            severity: low, medium or high.
            relatedTransactionId: Optional related transaction.
            relatedCustomerId: Optional related customer.
            tool_context: Injected ADK runtime context.
        """
        return await _call_gateway(
            "create_case",
            tool_context,
            gateway,
            kind=kind,
            title=title,
            summary=summary,
            severity=severity,
            relatedTransactionId=relatedTransactionId,
            relatedCustomerId=relatedCustomerId,
        )

    async def send_notification(recipient: str, subject: str, body: str, severity: Optional[str] = None, tool_context: Any = None) -> dict:
        """Send a sandbox notification to a recipient.

        Args:
            recipient: Recipient identifier.
            subject: Subject line.
            body: Message body.
            severity: info, warning or critical.
            tool_context: Injected ADK runtime context.
        """
        return await _call_gateway(
            "send_notification",
            tool_context,
            gateway,
            recipient=recipient,
            subject=subject,
            body=body,
            severity=severity,
        )

    async def generate_report(title: str, bodyMarkdown: str, transactionId: Optional[str] = None, tool_context: Any = None) -> dict:
        """Generate an audit-ready markdown report for a workflow or transaction.

        Args:
            title: Report title.
            bodyMarkdown: Markdown report body. State conclusions and evidence pointers only; never hidden reasoning.
            transactionId: Optional related transaction.
            tool_context: Injected ADK runtime context.
        """
        return await _call_gateway(
            "generate_report",
            tool_context,
            gateway,
            title=title,
            bodyMarkdown=bodyMarkdown,
            transactionId=transactionId,
        )

    return [
        get_transaction,
        get_customer,
        get_wallet_history,
        analyze_wallet,
        calculate_risk,
        check_compliance,
        reconcile_transaction,
        get_treasury_balance,
        create_case,
        send_notification,
        generate_report,
    ]
