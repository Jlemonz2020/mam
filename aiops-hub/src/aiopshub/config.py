from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any

from .util import ensure_dir, write_json


def resolve_home(explicit: str | None = None) -> Path:
    raw = explicit or os.environ.get("AIOPS_HOME", "")
    path = Path(raw).expanduser() if raw else Path.cwd() / "data"
    ensure_dir(path)
    return path.resolve()


def package_config_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "config"


class HubConfig:
    """Merged application configuration, persisted atomically under the data home."""

    def __init__(self, home: Path):
        self.home = home
        self.path = home / "config.json"
        self.data = self._load()

    def _load(self) -> dict[str, Any]:
        defaults = json.loads((package_config_dir() / "default_config.json").read_text(encoding="utf-8"))
        if self.path.exists():
            try:
                user = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                user = {}
            _deep_merge(defaults, user)
        write_json(self.path, defaults)
        return defaults

    def save(self) -> None:
        write_json(self.path, self.data)

    def get(self, dotted: str, default: Any = None) -> Any:
        node: Any = self.data
        for part in dotted.split("."):
            if not isinstance(node, dict) or part not in node:
                return default
            node = node[part]
        return node

    def adapters(self) -> dict[str, Any]:
        custom = self.get("adapters.overrides", {}) or {}
        base = json.loads((package_config_dir() / "adapters.json").read_text(encoding="utf-8"))["adapters"]
        result = copy.deepcopy(base)
        for platform, patch in custom.items():
            result.setdefault(platform, {}).update(patch)
        return result

    def adapter_dir(self, platform: str) -> Path:
        raw = self.adapters().get(platform, {}).get("credential_dir", "")
        if not raw:
            return self.home / "fake-clients" / platform
        path = Path(raw).expanduser()
        if not path.is_absolute():
            path = self.home / path
        return path.resolve()


def _deep_merge(target: dict[str, Any], source: dict[str, Any]) -> None:
    for key, value in source.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            _deep_merge(target[key], value)
        else:
            target[key] = value
