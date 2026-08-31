"""MiMi Money AgentOS — Google ADK financial agent runtime.

This service hosts the MiMi financial workforce as REAL Google ADK agents
(`google.adk.agents.LlmAgent`) powered by Gemini. It exposes a minimal HTTP
contract consumed by the MiMi Money AgentOS control plane through the
`GoogleAdkRemoteRuntime` adapter:

    GET  /healthz          → liveness + model + agent catalog
    POST /runs             → execute one ADK run for an agent

Every privileged tool call made inside ADK is routed BACK through the
MiMi Agent Gateway (`gateway_tool_call_url`), so identity → RBAC →
deterministic policy → human-approval enforcement stays identical no matter
where the reasoning happens.

SANDBOX ONLY: all financial operations are simulated; no real funds move.
"""

__version__ = "1.0.0"
