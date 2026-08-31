"""HTTP client for the MiMi Agent Gateway.

ADK tools never execute privileged financial capability directly. They call
back into the control plane's Gateway (`POST /api/mimi/gateway/tool-call`),
which enforces identity → RBAC → deterministic policy → human approval →
verification → audit before anything happens.
"""

from __future__ import annotations

from typing import Any, Optional

import httpx


class GatewayDenied(Exception):
    """Raised when the Gateway refuses or blocks a tool invocation."""


class GatewayClient:
    def __init__(self, base_url: str, token: Optional[str] = None, timeout: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self._timeout = timeout

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    async def invoke_tool(
        self,
        *,
        agent_id: str,
        tool_name: str,
        args: dict[str, Any],
        workflow_id: str | None = None,
        correlation_id: str | None = None,
    ) -> tuple[Any | None, str | None]:
        """Returns (result, error). Exactly one side is None on completion."""
        payload = {
            "agentId": agent_id,
            "toolName": tool_name,
            "args": args,
            "workflowId": workflow_id,
            "correlationId": correlation_id,
        }
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            try:
                resp = await client.post(self.base_url, json=payload, headers=self._headers())
            except httpx.HTTPError as exc:
                return None, f"gateway unreachable: {exc}"
        if resp.status_code != 200:
            try:
                detail = resp.json().get("error", resp.text)
            except Exception:
                detail = resp.text
            return None, f"gateway {resp.status_code}: {detail}"
        body = resp.json()
        if body.get("status") == "executed":
            return body.get("result"), None
        return None, body.get("error") or f"gateway decision: {body.get('decision')}"
