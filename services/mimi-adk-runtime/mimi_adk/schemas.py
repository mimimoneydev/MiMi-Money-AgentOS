"""Wire types shared with the control plane's `AgentRuntimeAdapter` contract."""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class RunRequest(BaseModel):
    runId: str
    agentId: str
    instruction: str
    context: dict[str, Any] = Field(default_factory=dict)
    workflowId: Optional[str] = None
    stepKey: Optional[str] = None
    """Control-plane URL that ADK tools call back for privileged capability."""
    gatewayToolCallUrl: str
    model: Optional[str] = None  # override the default Gemini model per-run


class ToolCallRecord(BaseModel):
    toolName: str
    args: dict[str, Any] = Field(default_factory=dict)
    gatewayDecision: str = "ALLOW"
    ok: bool
    resultSummary: str
    latencyMs: int = 0


class SessionEvent(BaseModel):
    at: str
    kind: Literal[
        "user-message", "model-text", "model-tool-call", "tool-response", "final", "error", "system"
    ]
    text: str
    meta: dict[str, Any] = Field(default_factory=dict)


class RunSnapshot(BaseModel):
    runId: str
    agentId: str
    sessionId: str
    workflowId: Optional[str] = None
    stepKey: Optional[str] = None
    status: str  # QUEUED | RUNNING | COMPLETED | FAILED | TIMEOUT | ...
    model: str
    adapterMode: Literal["remote"] = "remote"
    iterations: int = 0
    toolCalls: list[ToolCallRecord] = Field(default_factory=list)
    artifacts: dict[str, Any] = Field(default_factory=dict)
    outputText: Optional[str] = None
    error: Optional[str] = None
    startedAt: str
    finishedAt: Optional[str] = None
    tokenUsageEstimate: int = 0
    costUsdEstimate: float = 0.0
    sessionEvents: list[SessionEvent] = Field(default_factory=list)


class RunResponse(BaseModel):
    run: RunSnapshot


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    sandbox: bool = True
    model: str
    geminiConfigured: bool
    framework: str = "google-adk"
    agents: list[str]
