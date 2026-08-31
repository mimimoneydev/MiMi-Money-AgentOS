"""Unit tests that run WITHOUT google-adk installed (pure logic + HTTP mocks).

ADK-dependent paths are exercised only when the real package is present;
`pytest.importorskip` keeps the suite honest about what is covered.
"""

from __future__ import annotations

import json

import httpx
import pytest

from mimi_adk.agents import AGENT_IDS, AGENT_SPECS
from mimi_adk.config import Settings
from mimi_adk.gateway import GatewayClient
from mimi_adk.schemas import RunSnapshot, ToolCallRecord


def test_registry_matches_control_plane_workforce() -> None:
    assert len(AGENT_IDS) == 10
    assert set(AGENT_IDS) == {
        "orchestrator", "payment-agent", "fraud-agent", "compliance-agent",
        "risk-agent", "reconciliation-agent", "treasury-agent",
        "support-agent", "reporting-agent", "escalation-agent",
    }
    # Distinct privilege boundaries: fraud can never settle or reconcile.
    fraud = next(s for s in AGENT_SPECS if s["id"] == "fraud-agent")
    assert "reconcile_transaction" not in fraud["tools"]
    assert "send_notification" not in fraud["tools"]
    # Compliance may screen but never reconcile settlement legs.
    compliance = next(s for s in AGENT_SPECS if s["id"] == "compliance-agent")
    assert "reconcile_transaction" not in compliance["tools"]


def test_settings_defaults_to_gemini_flash() -> None:
    s = Settings(api_key="")
    assert s.model.startswith("gemini-")


@pytest.mark.asyncio
async def test_gateway_client_round_trip() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content.decode())
        return httpx.Response(200, json={"status": "executed", "result": {"riskScore": 0.42}})

    transport = httpx.MockTransport(handler)
    client = GatewayClient("http://gateway.test/api/mimi/gateway/tool-call")
    client._timeout = 5
    import httpx as _httpx

    async with _httpx.AsyncClient(transport=transport) as mock_client:
        # Patch the client factory inside gateway to use our transport.
        import mimi_adk.gateway as gw

        original = _httpx.AsyncClient

        def factory(*args, **kwargs):
            kwargs["transport"] = transport
            return original(*args, **kwargs)

        gw.httpx.AsyncClient = factory  # type: ignore[assignment]
        try:
            result, error = await client.invoke_tool(
                agent_id="risk-agent", tool_name="calculate_risk", args={"fraudRiskScore": 0.2}
            )
        finally:
            gw.httpx.AsyncClient = original  # type: ignore[assignment]

    assert error is None
    assert result == {"riskScore": 0.42}
    assert captured["body"]["agentId"] == "risk-agent"
    assert captured["body"]["toolName"] == "calculate_risk"


@pytest.mark.asyncio
async def test_gateway_client_surfaces_denials() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "denied", "decision": "DENY", "error": "RBAC: not authorized"})

    import mimi_adk.gateway as gw
    import httpx as _httpx

    original = _httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return original(*args, **kwargs)

    gw.httpx.AsyncClient = factory  # type: ignore[assignment]
    client = GatewayClient("http://gateway.test/x")
    try:
        result, error = await client.invoke_tool(
            agent_id="support-agent", tool_name="reconcile_transaction", args={"transactionId": "t1"}
        )
    finally:
        gw.httpx.AsyncClient = original  # type: ignore[assignment]
    assert result is None
    assert error is not None and "RBAC" in error


def test_run_snapshot_shape_matches_ts_contract() -> None:
    snap = RunSnapshot(
        runId="run_x", agentId="payment-agent", sessionId="ses_x", status="COMPLETED",
        model="gemini-3.6-flash", adapterMode="remote", startedAt="2026-01-01T00:00:00Z",
        toolCalls=[ToolCallRecord(toolName="get_transaction", ok=True, resultSummary="{}")],
    )
    payload = snap.model_dump()
    for key in ("runId", "agentId", "sessionId", "status", "model", "adapterMode",
                "iterations", "toolCalls", "artifacts", "outputText", "error",
                "startedAt", "finishedAt", "tokenUsageEstimate", "costUsdEstimate", "sessionEvents"):
        assert key in payload


def test_adk_agents_build_when_dependency_present() -> None:
    pytest.importorskip("google.adk")
    from mimi_adk.tools import build_tools
    from mimi_adk.agents import build_all_agents

    gateway = GatewayClient("http://gateway.test/x")
    tools = build_tools(gateway)
    by_name = {fn.__name__: fn for fn in tools}
    agents = build_all_agents(by_name, "gemini-3.6-flash")
    assert len(agents) == 10
