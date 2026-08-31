# MiMi ADK Runtime — real Google ADK financial agents

This service hosts the MiMi financial workforce as **actual Google ADK agents**
(`google.adk` `LlmAgent`s powered by Gemini). It is the production execution
backend selected by the control plane when `MIMI_ADK_RUNTIME_URL` is set:

```
MiMi Money AgentOS control plane
  └── GoogleAdkRemoteRuntime (AgentRuntimeAdapter)
        └── POST /runs → this service → google-adk Runner (Gemini)
              └── every privileged tool call → POST /api/mimi/gateway/tool-call
                    └── identity → RBAC → deterministic Policy Engine → audit
```

The reasoning happens in ADK/Gemini; the authority stays in the Gateway.

## Layout

| Path | Purpose |
|---|---|
| `mimi_adk/agents.py` | The 10-agent workforce as ADK `LlmAgent` specs + builder |
| `mimi_adk/tools.py` | The 12 financial tools as ADK function tools (Gateway-backed) |
| `mimi_adk/gateway.py` | HTTP client back to the MiMi Agent Gateway |
| `mimi_adk/service.py` | FastAPI: `GET /healthz`, `POST /runs` |
| `tests/` | Dependency-free unit tests (+ ADK tests when installed) |

## Local run

```sh
cd services/mimi-adk-runtime
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
export GOOGLE_API_KEY=...            # AI Studio key for local runs
uvicorn mimi_adk.service:app --port 9700
pytest                                # unit tests (no key needed)
```

Then point the control plane at it:

```sh
# repo root
MIMI_ADK_RUNTIME_URL=http://localhost:9700 pnpm dev
curl -s localhost:9700/healthz | jq
```

Every payment simulation now executes its agent steps through real
google-adk Runners; tool results still flow through the Gateway, so the UI,
audit trail and policy decisions are identical across runtime modes.

## Cloud Run

See `deploy/deploy-cloudrun.sh` and `MIMI_AGENTOS_DEPLOYMENT.md`
(`mimi-agent-runtime` service, scale-to-zero, Secret Manager for the API key).

SANDBOX ONLY — all financial operations are simulated; no real funds move.
