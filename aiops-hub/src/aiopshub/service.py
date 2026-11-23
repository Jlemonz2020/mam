from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .accounts import AccountPool
from .adapters import AdapterManager
from .agents import AgentRegistry
from .config import HubConfig, resolve_home
from .notify import NotifyCenter
from .observer import Observer
from .scheduler import Scheduler
from .storage import RecordsStore
from .switcher import Switcher
from .util import FileLock, gen_id, now_ms
from .vault import Vault


class Hub:
    """Unified facade: all modules collaborate through this object."""

    def __init__(self, home: Path | str | None = None, password: str | None = None):
        self.home = resolve_home(str(home) if home else None)
        self.config = HubConfig(self.home)
        self.vault = Vault(
            self.home,
            password_env=str(self.config.get("security.password_env", "AIOPS_PASSWORD")),
            password_file_env=str(self.config.get("security.password_file_env", "AIOPS_PASSWORD_FILE")),
        )
        self.pool = AccountPool(self.home)
        self.adapters = AdapterManager(self.config)
        self.records = RecordsStore(self.home / "records.jsonl", max_lines=20000)
        self.notify = NotifyCenter(self.config, self.records)
        self.switcher = Switcher(self.home, self.config, self.pool, self.adapters, self.records, self.notify)
        self.observer = Observer(self.pool, self.records)
        self.scheduler = Scheduler(self)
        self.agents = AgentRegistry(self.home, self.config)
        self._password = password
        self._last_request_at = 0.0

    # ---------- lifecycle ----------
    def init(self, password: str) -> dict[str, Any]:
        self.vault.initialize(password)
        self._password = password
        self.records.append("log", {"taskType": "init", "status": "ok", "detail": "vault initialized"})
        return {"ok": True, "home": str(self.home)}

    def unlock(self, password: str | None = None) -> None:
        secret = password or self._password
        self.vault.unlock(secret)
        self._password = secret

    def _ensure_unlocked(self) -> None:
        if not self.vault.unlocked:
            self.vault.unlock(self._password)

    # ---------- account pool ----------
    def add_account(
        self,
        name: str,
        platform: str,
        groups: list[str] | None = None,
        password: str | None = None,
        capture: bool = True,
    ) -> dict[str, Any]:
        self._ensure_unlocked()
        if platform not in self.adapters.adapters:
            raise ValueError(f"unknown platform: {platform}")
        files = self.adapters.capture(platform) if capture else {}
        if not files:
            token_name = self.adapters.adapters[platform].get("token_file") or "auth.json"
            files = {token_name: json.dumps({"token": gen_id("tok-"), "device_id": gen_id("dev-")}, ensure_ascii=False).encode("utf-8")}
            self.adapters.apply(platform, files)
        credential_id = gen_id("cred-")
        self.vault.put(credential_id, files)
        account = self.pool.add(name, platform, credential_id, groups or [])
        self._ensure_groups(groups or [])
        self.records.append("log", {"taskType": "account_add", "accountId": account.id, "status": "ok", "detail": platform})
        return account.to_dict()

    def _ensure_groups(self, groups: list[str]) -> None:
        for group in groups:
            self.pool.add_group(group)

    def list_accounts(self) -> list[dict[str, Any]]:
        return [account.to_dict() for account in self.pool.list()]

    def switch(
        self,
        account_id: int,
        password: str | None = None,
        allow_while_running: bool = False,
        agent_id: str | None = None,
        prefer_agent: bool = False,
    ) -> dict[str, Any]:
        account = self.pool.get(account_id)
        if not account:
            raise ValueError(f"account {account_id} not found")
        target_agent = agent_id
        if not target_agent and prefer_agent and self.config.get("agent.enabled", True):
            online = self.agents.online_agents(account.platform)
            if online:
                target_agent = online[0]["id"]
        if target_agent:
            command = self.agents.dispatch(
                target_agent,
                {
                    "type": "switch",
                    "payload": {
                        "account_id": account_id,
                        "platform": account.platform,
                        "credential_id": account.credential_id,
                        "allow_while_running": allow_while_running,
                    },
                },
            )
            self.records.append(
                "log",
                {"taskType": "switch_dispatch", "accountId": account_id, "status": "ok", "detail": json.dumps(command, ensure_ascii=False)},
            )
            return {
                "ok": True,
                "dispatched": True,
                "command_id": command["id"],
                "seq": command["seq"],
                "agent_id": target_agent,
                "status": "pending",
            }
        return self.switcher.switch(account_id, password or self._password, allow_while_running)

    # ---------- automated operations ----------
    def _throttle(self) -> None:
        minimum = int(self.config.get("limits.min_request_interval_ms", 0))
        elapsed = (time.monotonic() - self._last_request_at) * 1000
        if self._last_request_at and elapsed < minimum:
            time.sleep((minimum - elapsed) / 1000)
        self._last_request_at = time.monotonic()

    def checkin(self, account_id: int, scheduled: bool = False, task_type: str = "checkin", auto_switch: bool = False) -> dict[str, Any]:
        account = self.pool.get(account_id)
        if not account:
            raise ValueError(f"account {account_id} not found")
        today = datetime.now().strftime("%Y-%m-%d")
        limit = int(self.config.get("limits.max_checkin_per_day", 1))
        prior = [r for r in self.records.read(5000, "checkin") if r["r"].get("accountId") == account_id and r["r"].get("checkinDate") == today]
        success_count = sum(1 for r in prior if r["r"].get("status") == "success")
        if success_count >= limit:
            return {"ok": True, "account_id": account_id, "status": "skipped", "reason": "daily limit reached"}

        self._throttle()
        self._ensure_unlocked()
        files = self.vault.get(account.credential_id) or {}
        result = self.adapters.checkin(account.platform, account.id, account.name, files)
        reward = int(result.get("reward", 0) or 0)
        balance = result.get("balance")
        status = result.get("status", "success")
        record = {
            "id": gen_id("ci-"),
            "accountId": account_id,
            "platform": account.platform,
            "checkinDate": today,
            "status": status,
            "message": result.get("message"),
            "reward": reward,
            "retried": len(prior),
            "executedAt": now_ms(),
            "scheduled": scheduled,
            "taskType": task_type,
        }
        self.records.append("checkin", record)
        changes: dict[str, Any] = {"last_checkin_date": today}
        if balance is not None:
            changes["points"] = int(balance)
            self.records.append("snapshot", {"id": gen_id("sn-"), "accountId": account_id, "balance": int(balance), "capturedAt": now_ms()})
        if status == "success":
            changes["fail_streak"] = 0
            changes["health"] = "healthy"
        elif status == "failed":
            streak = account.fail_streak + 1
            changes["fail_streak"] = streak
            changes["health"] = "degraded" if streak < 2 else "invalid"
            if streak >= 2:
                self.notify.emit("checkin_failed_twice", f"account #{account_id} failed {streak} times", "warning", account_id)
            if streak >= 3:
                changes["status"] = "invalid"
                self.notify.emit("account_invalid", f"account #{account_id} marked invalid", "error", account_id)
        self.pool.update(account_id, **changes)
        outcome = {"ok": status in ("success", "skipped"), "account_id": account_id, "status": status, "reward": reward, "balance": balance}
        if auto_switch and status == "success" and self.config.get("switch.auto_switch_after_checkin", False):
            next_account = self.pool.select(account.platform, str(self.config.get("switch.strategy", "round-robin")))
            if next_account and next_account.id != account_id:
                outcome["next_account"] = self.switch(next_account.id, prefer_agent=True).get("account_id")
        return outcome

    def points(self, account_id: int) -> dict[str, Any]:
        account = self.pool.get(account_id)
        if not account:
            raise ValueError(f"account {account_id} not found")
        self._throttle()
        self._ensure_unlocked()
        files = self.vault.get(account.credential_id) or {}
        result = self.adapters.points(account.platform, account_id, files)
        balance = result.get("balance")
        quota = result.get("quota")
        if balance is not None:
            self.records.append("snapshot", {"id": gen_id("sn-"), "accountId": account_id, "balance": int(balance), "capturedAt": now_ms()})
        changes: dict[str, Any] = {}
        if balance is not None:
            changes["points"] = int(balance)
        if quota is not None:
            changes["quota"] = int(quota)
        if changes:
            self.pool.update(account_id, **changes)
        return {"ok": result.get("status") in ("success", "skipped"), "account_id": account_id, **result}

    def keepalive(self, account_id: int) -> dict[str, Any]:
        self.records.append("task", {"taskType": "keepalive", "accountId": account_id, "status": "ok", "at": now_ms()})
        return {"ok": True, "account_id": account_id, "action": "keepalive"}

    def wakeup(self, account_id: int) -> dict[str, Any]:
        self.records.append("task", {"taskType": "wakeup", "accountId": account_id, "status": "ok", "at": now_ms()})
        return {"ok": True, "account_id": account_id, "action": "wakeup"}

    def health_check(self, account_id: int) -> dict[str, Any]:
        account = self.pool.get(account_id)
        if not account:
            return {"ok": False, "account_id": account_id, "error": "not found"}
        health = "invalid" if account.status != "active" else ("degraded" if account.fail_streak else "healthy")
        self.pool.update(account_id, health=health)
        return {"ok": True, "account_id": account_id, "health": health}

    # ---------- unified gateway ----------
    def gateway_request(self, api_key: str, model: str, messages: list[dict[str, Any]], client_ip: str = "127.0.0.1") -> dict[str, Any]:
        keys = self.config.get("gateway.keys", []) or []
        definition = next((item for item in keys if item.get("key") == api_key), None)
        if not definition:
            return {"ok": False, "error": "invalid api key", "status": 401}
        allowed_models = definition.get("model_whitelist") or []
        if allowed_models and model not in allowed_models:
            return {"ok": False, "error": "model not allowed", "status": 403}
        ip_whitelist = definition.get("ip_whitelist") or []
        if ip_whitelist and client_ip not in ip_whitelist:
            return {"ok": False, "error": "ip not allowed", "status": 403}
        quota = int(definition.get("quota", 0) or 0)
        if quota > 0:
            used = sum(1 for record in self.records.read(5000, "gateway") if record["r"].get("key_name") == definition.get("name"))
            if used >= quota:
                return {"ok": False, "error": "api key quota exceeded", "status": 429}

        platform = definition.get("platform") or "trae"
        account = self.pool.select(platform, str(self.config.get("switch.strategy", "round-robin")))
        if not account:
            return {"ok": False, "error": "no healthy account in pool", "status": 503}
        self._ensure_unlocked()
        files = self.vault.get(account.credential_id) or {}
        token = self.adapters.extract_token(platform, files)
        upstream = str(self.config.get("gateway.upstream_url", ""))
        payload = json.dumps(
            {"model": model, "messages": messages, "platform": platform, "account_id": account.id}, ensure_ascii=False
        ).encode("utf-8")
        headers = {"Content-Type": "application/json", "X-Account-Token": token or ""}
        started = time.monotonic()
        try:
            request = urllib.request.Request(upstream, data=payload, headers=headers, method="POST")
            with urllib.request.urlopen(request, timeout=5) as response:
                upstream_result = json.loads(response.read().decode("utf-8"))
            status = 200
        except urllib.error.HTTPError as exc:
            upstream_result = {"error": exc.read().decode("utf-8", "replace")}
            status = exc.code
        except Exception as exc:
            upstream_result = {"error": str(exc)}
            status = 502
        latency_ms = int((time.monotonic() - started) * 1000)
        self.records.append(
            "gateway",
            {
                "key_name": definition.get("name", "unknown"),
                "account_id": account.id,
                "platform": platform,
                "model": model,
                "status": status,
                "tokens": int(upstream_result.get("usage", {}).get("total_tokens", 0) or 0),
                "latency_ms": latency_ms,
                "at": now_ms(),
            },
        )
        return {"ok": status == 200, "status": status, "account_id": account.id, "result": upstream_result}

    # ---------- agent transport ----------
    def agents_summary(self) -> dict[str, Any]:
        return self.agents.summary()

    def wrap_credential_for_agent(self, credential_id: str, agent_token: str) -> str:
        self._ensure_unlocked()
        return self.vault.export_for_agent(credential_id, agent_token)

    def store_agent_credential(self, credential_id: str, blob: str, agent_token: str) -> int:
        self._ensure_unlocked()
        files = Vault.import_from_agent(blob, agent_token)
        self.vault.put(credential_id, files)
        return len(files)

    # ---------- diagnostics & views ----------
    def doctor(self) -> dict[str, Any]:
        checks: list[dict[str, Any]] = []
        checks.append({"name": "config", "ok": self.config.path.exists(), "detail": str(self.config.path)})
        checks.append({"name": "vault", "ok": self.vault.initialized, "detail": "initialized" if self.vault.initialized else "not initialized"})
        checks.append({"name": "accounts", "ok": (self.home / "accounts.json").exists(), "detail": str(len(self.pool.list())) + " accounts"})
        for adapter in self.adapters.describe():
            checks.append(
                {
                    "name": f"dir:{adapter['platform']}",
                    "ok": Path(adapter["credential_dir"]).exists(),
                    "detail": adapter["credential_dir"],
                    "critical": False,
                }
            )
        checks.append({"name": "gateway-key", "ok": bool(self.config.get("gateway.keys")), "detail": str(len(self.config.get("gateway.keys", [])))})
        return {"ok": all(c["ok"] for c in checks if c.get("critical", True)), "checks": checks, "home": str(self.home)}

    def summary(self) -> dict[str, Any]:
        return self.observer.summary()

    def report(self, month: str | None = None) -> dict[str, Any]:
        return self.observer.report(month)

    def usage(self) -> dict[str, Any]:
        return self.observer.usage()

    def health(self) -> list[dict[str, Any]]:
        return self.observer.health()

    def events(self, limit: int = 100, event_type: str | None = None) -> list[dict[str, Any]]:
        return self.records.read(limit, event_type)

    def start_scheduler(self) -> None:
        self.scheduler.start()

    def stop_scheduler(self) -> None:
        self.scheduler.stop()
