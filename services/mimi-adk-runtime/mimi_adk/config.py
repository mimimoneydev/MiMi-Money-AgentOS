"""Environment-driven configuration for the MiMi ADK runtime."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _model_default() -> str:
    return os.environ.get(
        "MIMI_GEMINI_MISSION_MODEL",
        os.environ.get("MIMI_GEMINI_MODEL", "gemini-3.6-flash"),
    )


def _light_model_default() -> str:
    return os.environ.get("MIMI_GEMINI_LIGHT_MODEL", "gemini-3.5-flash")


def _api_key() -> str:
    for name in ("GOOGLE_API_KEY", "GEMINI_API_KEY", "MIMI_GEMINI_API_KEY"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


@dataclass
class Settings:
    model: str = field(default_factory=_model_default)
    light_model: str = field(default_factory=_light_model_default)
    api_key: str = field(default_factory=_api_key)
    region: str = field(default_factory=lambda: os.environ.get("MIMI_CLOUD_RUN_REGION", "africa-south1"))
    sandbox: bool = True

    @property
    def gemini_configured(self) -> bool:
        return bool(self.api_key)

    def model_for_agent(self, agent_id: str) -> str:
        return self.light_model if agent_id in {"support-agent", "reporting-agent", "escalation-agent"} else self.model


settings = Settings()
