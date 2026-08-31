"""FastAPI surface: GET /healthz, POST /runs (one real google-adk Runner run).

The control plane's `GoogleAdkRemoteRuntime` adapter calls POST /runs. The
service builds a fresh ADK session per run, streams the agent's events,
records tool calls (executed via Gateway callbacks) and returns a snapshot
in the exact shape the TypeScript `AdkRunSnapshot` contract expects.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException

from .agents import AGENT_IDS, build_agent, SANDBOX_PREAMBLE
from .config import settings
from .gateway import GatewayClient
from .schemas import HealthResponse, RunRequest, RunResponse, RunSnapshot, SessionEvent, ToolCallRecord
from .tools import build_tools

app = FastAPI(title="MiMi ADK Runtime", version="1.0.0")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@app.get("/healthz", response_model=HealthResponse)
async def healthz() -> HealthResponse:
    return HealthResponse(
        status="ok" if settings.gemini_configured else "degraded",
        sandbox=True,
        model=settings.model,
        geminiConfigured=settings.geminiConfigured,
        agents=AGENT_IDS,
    )


@app.post("/runs", response_model=RunResponse)
async def execute_run(req: RunRequest) -> RunResponse:
    if not settings.gemini_configured:
        raise HTTPException(
            status_code=503,
            detail="GOOGLE_API_KEY is not configured on the MiMi ADK runtime; "
            "set it (or run the control plane in gemini/local-simulation mode).",
        )

    try:
        from google.adk.runners import InMemoryRunner
        from google.adk.sessions import InMemorySessionManager  # noqa: F401 — documents session backend
    except ImportError as exc:  # pragma: no cover — only when deps missing
        raise HTTPException(status_code=503, detail=f"google-adk unavailable: {exc}") from exc

    model = req.model or settings.model_for_agent(req.agentId)
    gateway = GatewayClient(req.gatewayToolCallUrl)
    tool_objs = build_tools(gateway)
    tools_by_name = {fn.__name__: fn for fn in tool_objs}
    agent = build_agent(req.agentId, tools_by_name, model)

    started = _now()
    snapshot = RunSnapshot(
        runId=req.runId,
        agentId=req.agentId,
        sessionId=f"ses_{uuid.uuid4().hex[:10]}",
        workflowId=req.workflowId,
        stepKey=req.stepKey,
        status="RUNNING",
        model=model,
        adapterMode="remote",
        iterations=0,
        startedAt=started,
        sessionEvents=[
            SessionEvent(at=started, kind="user-message", text=req.instruction, meta={"context": req.context}),
            SessionEvent(
                at=started,
                kind="system",
                text="google-adk runtime attached; privileged tools gated by MiMi Agent Gateway",
            ),
        ],
    )

    recorder: dict = {
        "agentId": req.agentId,
        "workflowId": req.workflowId,
        "toolCalls": [],
    }

    async def _run() -> None:
        runner = InMemoryRunner(agent=agent, app_name="mimi-agentos")
        session = await runner.session_service.create_session(
            app_name="mimi-agentos", user_id="mimi-control-plane"
        )
        message = {"role": "user", "parts": [{"text": req.instruction}]}
        final_text: str | None = None
        async for event in runner.run_async(
            user_id="mimi-control-plane", session_id=session.id, new_message=message
        ):
            snapshot.iterations += 1
            # Record function calls / responses surfaced by ADK events.
            calls = getattr(getattr(event, "content", None), "parts", []) or []
            for part in calls:
                fn_call = getattr(part, "function_call", None)
                if fn_call is not None:
                    snapshot.sessionEvents.append(
                        SessionEvent(at=_now(), kind="model-tool-call", text=fn_call.name, meta={"args": dict(fn_call.args or {})})
                    )
                text = getattr(part, "text", None)
                if text:
                    final_text = text
        # Pull the authoritative tool-call records collected by the wrappers.
        for call in recorder.get("toolCalls", []):
            record = ToolCallRecord(**call)
            snapshot.toolCalls.append(record)
            if record.ok and record.resultSummary.strip().startswith("{"):
                try:
                    import json

                    snapshot.artifacts[record.toolName] = json.loads(record.resultSummary)
                except Exception:
                    pass
        usage = 320 * max(snapshot.iterations, 1)  # conservative token estimate
        snapshot.tokenUsageEstimate = usage
        snapshot.costUsdEstimate = round(usage * 0.0000015, 6)
        snapshot.outputText = (final_text or "(no textual output)").strip()
        snapshot.status = "COMPLETED"
        snapshot.finishedAt = _now()
        snapshot.sessionEvents.append(SessionEvent(at=snapshot.finishedAt, kind="final", text=snapshot.outputText))

    try:
        await asyncio.wait_for(_run(), timeout=float(os.environ.get("MIMI_ADK_RUN_TIMEOUT_S", "55")))
    except asyncio.TimeoutError:
        snapshot.status = "TIMEOUT"
        snapshot.error = f"remote ADK run exceeded timeout"
        snapshot.finishedAt = _now()
        snapshot.sessionEvents.append(SessionEvent(at=snapshot.finishedAt, kind="error", text=snapshot.error))
    except Exception as exc:  # noqa: BLE001 — surface model errors to the control plane
        snapshot.status = "FAILED"
        snapshot.error = str(exc)
        snapshot.finishedAt = _now()
        snapshot.sessionEvents.append(SessionEvent(at=snapshot.finishedAt, kind="error", text=str(exc)))

    return RunResponse(run=snapshot)


__all__ = ["app", "SANDBOX_PREAMBLE"]
