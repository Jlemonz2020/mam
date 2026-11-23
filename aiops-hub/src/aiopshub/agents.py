from __future__ import annotations

import hashlib
import hmac
import secrets
import threading
from pathlib import Path
from typing import Any

from .config import HubConfig
from .storage import StateStore
from .util import ensure_dir, gen_id, now_ms

DEFAULT_AGENTS: dict[str, Any] = {"version": 1, "seq": 0, "agents": {}, "commands": []}


class AgentRegistry:
    """Server-side registry, command queue and persistent context for Windows agents."""

    def __init__(self, home: Path, config: HubConfig):
        self.home = home
        self.config = config
        self.store = StateStore(home / "agents.json", DEFAULT_AGENTS)
        self.contexts_dir = home / "contexts"
        self._lock = threading.RLock()

    # ---------- registration / auth ----------
    def register(self, machine_id: str, platform: str, credential_dir: str = "") -> dict[str, Any]:
        with self._lock:
            state = self.store.load()
            agent_id = gen_id("agt-")
            token = secrets.token_urlsafe(32)
            state["agents"][agent_id] = {
                "id": agent_id,
                "machine_id": machine_id,
                "platform": platform,
                "credential_dir": credential_dir,
                "token_hash": hashlib.sha256(token.encode("utf-8")).hexdigest(),
                "registered_at": now_ms(),
                "last_seen": 0,
                "online": False,
            }
            self.store.save(state)
        return {"agent_id": agent_id, "agent_token": token, "platform": platform, "machine_id": machine_id}

    def authenticate(self, agent_id: str, token: str) -> bool:
        record = self.get(agent_id)
        if not record or not token:
            return False
        expected = record.get("token_hash", "")
        return hmac.compare_digest(hashlib.sha256(token.encode("utf-8")).hexdigest(), expected)

    def get(self, agent_id: str) -> dict[str, Any] | None:
        return self.store.load()["agents"].get(agent_id)

    # ---------- heartbeat / context ----------
    def heartbeat(self, agent_id: str, context: dict[str, Any] | None = None) -> dict[str, Any]:
        with self._lock:
            state = self.store.load()
            record = state["agents"].get(agent_id)
            if not record:
                raise KeyError(f"unknown agent: {agent_id}")
            record["last_seen"] = now_ms()
            record["online"] = True
            if context and context.get("platform"):
                record["platform"] = context["platform"]
            self.store.save(state)
            if context is not None:
                self.save_context(agent_id, context)
            return dict(record)

    def save_context(self, agent_id: str, context: dict[str, Any]) -> dict[str, Any]:
        ensure_dir(self.contexts_dir)
        data = dict(context)
        data.setdefault("agent_id", agent_id)
        data.setdefault("last_seq", 0)
        data["updated_at"] = now_ms()
        store = StateStore(self.contexts_dir / f"{agent_id}.json", data)
        store.save(data)
        return data

    def context(self, agent_id: str) -> dict[str, Any]:
        ensure_dir(self.contexts_dir)
        store = StateStore(self.contexts_dir / f"{agent_id}.json", {"agent_id": agent_id, "last_seq": 0})
        return store.load()

    # ---------- online / dispatch ----------
    def online_agents(self, platform: str | None = None) -> list[dict[str, Any]]:
        timeout = int(self.config.get("agent.heartbeat_timeout_seconds", 90))
        threshold = now_ms() - timeout * 1000
        result = []
        for record in self.store.load()["agents"].values():
            if not record.get("online") or record.get("last_seen", 0) < threshold:
                continue
            if platform and record.get("platform") != platform:
                continue
            result.append(dict(record))
        return result

    def dispatch(self, agent_id: str, command: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            state = self.store.load()
            if agent_id not in state["agents"]:
                raise KeyError(f"unknown agent: {agent_id}")
            state["seq"] += 1
            ttl = int(self.config.get("agent.command_ttl_seconds", 300))
            item = {
                "id": command.get("id") or gen_id("cmd-"),
                "seq": state["seq"],
                "agent_id": agent_id,
                "type": command.get("type", "switch"),
                "status": "pending",
                "lease_until": 0,
                "created_at": now_ms(),
                "payload": command.get("payload", {}),
            }
            state["commands"].append(item)
            self.store.save(state)
            return dict(item)

    def poll(self, agent_id: str, since: int = 0) -> list[dict[str, Any]]:
        with self._lock:
            state = self.store.load()
            ttl = int(self.config.get("agent.command_ttl_seconds", 300))
            now = now_ms()
            changed = False
            result: list[dict[str, Any]] = []
            for item in state["commands"]:
                if item.get("agent_id") != agent_id or item.get("seq", 0) <= int(since):
                    continue
                if item.get("status") == "done":
                    continue
                lease = int(item.get("lease_until", 0) or 0)
                if lease > now:
                    continue
                item["status"] = "leased"
                item["lease_until"] = now + ttl * 1000
                result.append(dict(item))
                changed = True
            if changed:
                self.store.save(state)
            return result

    def ack(self, agent_id: str, command_id: str, status: str, result: dict[str, Any] | None = None, context: dict[str, Any] | None = None) -> dict[str, Any] | None:
        with self._lock:
            state = self.store.load()
            for item in state["commands"]:
                if item.get("id") == command_id and item.get("agent_id") == agent_id:
                    item["status"] = "done"
                    item["result"] = result or {}
                    item["completed_at"] = now_ms()
                    self.store.save(state)
                    if context is not None:
                        self.save_context(agent_id, context)
                    return dict(item)
            return None

    def commands(self, limit: int = 100) -> list[dict[str, Any]]:
        commands = self.store.load()["commands"]
        return [dict(item) for item in commands[-limit:]]

    def summary(self) -> dict[str, Any]:
        state = self.store.load()
        agents = []
        for record in state["agents"].values():
            item = dict(record)
            item.pop("token_hash", None)
            item["online"] = item.get("last_seen", 0) >= now_ms() - int(self.config.get("agent.heartbeat_timeout_seconds", 90)) * 1000
            item["context"] = self.context(item["id"])
            agents.append(item)
        return {"seq": state["seq"], "agents": agents, "commands": self.commands(50)}
