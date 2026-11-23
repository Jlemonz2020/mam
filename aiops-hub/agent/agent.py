#!/usr/bin/env python3
"""Windows Agent for AIOpsHub remote account switching and context sync."""
from __future__ import annotations

import argparse
import json
import os
import platform as platform_lib
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from aiopshub.util import ensure_dir, fsync_path, now_ms, write_json  # noqa: E402
from aiopshub.vault import Vault  # noqa: E402

DEFAULT_HOME = Path(os.environ.get("APPDATA", str(Path.home()))) / "AIOpsAgent"
MAX_FILE_BYTES = 2 * 1024 * 1024


class AgentClient:
    """Outbound-only agent: register, heartbeat, poll, switch, ack, sync context."""

    def __init__(self, home: Path | None = None):
        self.home = (home or DEFAULT_HOME).resolve()
        ensure_dir(self.home)
        self.config_path = self.home / "config.json"
        self.context_path = self.home / "context.json"
        self.journal_path = self.home / "journal.json"
        self.applied_path = self.home / "applied-commands.log"
        self.snapshots = self.home / "snapshots"
        self.config = self._read(self.config_path, {})

    @staticmethod
    def _read(path: Path, default: Any) -> Any:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return default

    # ---------- transport ----------
    def _request(self, method: str, path: str, body: dict[str, Any] | None = None, extra_headers: dict[str, str] | None = None) -> dict[str, Any]:
        base = str(self.config.get("server_url", "")).rstrip("/")
        if not base:
            raise RuntimeError("agent not registered: server_url missing")
        headers = {"Content-Type": "application/json"}
        if self.config.get("agent_token"):
            headers["X-Agent-Token"] = str(self.config["agent_token"])
        if extra_headers:
            headers.update(extra_headers)
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        request = urllib.request.Request(base + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            raise RuntimeError(f"HTTP {exc.code} on {path}: {detail}") from exc

    # ---------- registration ----------
    def register(self, server_url: str, admin_key: str, machine_id: str, target_platform: str, credential_dir: str) -> dict[str, Any]:
        self.config["server_url"] = server_url.rstrip("/")
        result = self._request(
            "POST",
            "/agent/register",
            {"machine_id": machine_id, "platform": target_platform, "credential_dir": credential_dir},
            {"X-Admin-Key": admin_key},
        )
        self.config = {
            "server_url": server_url.rstrip("/"),
            "agent_id": result["agent_id"],
            "agent_token": result["agent_token"],
            "machine_id": machine_id,
            "platform": target_platform,
            "credential_dir": credential_dir,
            "poll_interval_seconds": int(self.config.get("poll_interval_seconds", 5)),
        }
        write_json(self.config_path, self.config)
        self.heartbeat({"last_seq": 0, "active": {}, "phase": "idle"})
        return result

    @property
    def registered(self) -> bool:
        return bool(self.config.get("agent_id") and self.config.get("agent_token"))

    # ---------- local context ----------
    def load_context(self) -> dict[str, Any]:
        return self._read(
            self.context_path,
            {"agent_id": self.config.get("agent_id", ""), "last_seq": 0, "active": {}, "phase": "idle", "last_command_id": ""},
        )

    def save_context(self, context: dict[str, Any]) -> None:
        context["agent_id"] = self.config.get("agent_id", "")
        context["updated_at"] = now_ms()
        write_json(self.context_path, context)

    def _applied(self) -> set[str]:
        if not self.applied_path.exists():
            return set()
        return {line.strip() for line in self.applied_path.read_text(encoding="utf-8").splitlines() if line.strip()}

    def _mark_applied(self, command_id: str) -> None:
        with self.applied_path.open("a", encoding="utf-8") as fh:
            fh.write(command_id + "\n")
            fh.flush()
        fsync_path(self.applied_path)

    # ---------- server calls ----------
    def heartbeat(self, context: dict[str, Any] | None = None) -> dict[str, Any]:
        context = context or self.load_context()
        return self._request("POST", "/agent/heartbeat", {"agent_id": self.config["agent_id"], "context": context})

    def poll(self, since: int) -> list[dict[str, Any]]:
        query = urllib.parse.urlencode({"agent_id": self.config["agent_id"], "since": since})
        return self._request("GET", f"/agent/commands/poll?{query}").get("commands", [])

    def fetch_credential(self, credential_id: str) -> str:
        query = urllib.parse.urlencode({"agent_id": self.config["agent_id"], "credential_id": credential_id})
        return self._request("GET", f"/agent/credentials?{query}")["blob"]

    def upload_credential(self, credential_id: str, blob: str) -> None:
        self._request(
            "POST",
            "/agent/credentials/upload",
            {"agent_id": self.config["agent_id"], "credential_id": credential_id, "blob": blob},
        )

    def ack(self, command_id: str, status: str, result: dict[str, Any], context: dict[str, Any]) -> None:
        self._request(
            "POST",
            "/agent/commands/ack",
            {"agent_id": self.config["agent_id"], "command_id": command_id, "status": status, "result": result, "context": context},
        )

    # ---------- local transactional switch ----------
    def recover(self) -> dict[str, Any] | None:
        journal = self._read(self.journal_path, {})
        phase = journal.get("phase")
        if not phase:
            return None
        target = Path(journal.get("target_dir", "")) if journal.get("target_dir") else None
        backup = Path(journal.get("backup_dir", "")) if journal.get("backup_dir") else None
        result = {"phase": phase, "recovered": False}
        if backup and backup.exists() and target:
            shutil.rmtree(target, ignore_errors=True)
            shutil.move(str(backup), str(target))
            result["recovered"] = True
            context = self.load_context()
            context["phase"] = "recovered"
            self.save_context(context)
        self.journal_path.unlink(missing_ok=True)
        return result

    def _capture(self, root: Path) -> dict[str, bytes]:
        files: dict[str, bytes] = {}
        if not root.exists():
            return files
        for path in root.rglob("*"):
            if path.is_file() and path.stat().st_size <= MAX_FILE_BYTES:
                files[path.relative_to(root).as_posix()] = path.read_bytes()
        return files

    def execute_command(self, command: dict[str, Any]) -> dict[str, Any]:
        command_id = str(command.get("id", ""))
        context = self.load_context()
        if command_id in self._applied():
            self.ack(command_id, "done", {"skipped": True, "reason": "already applied"}, context)
            return {"command_id": command_id, "ok": True, "skipped": True}

        payload = command.get("payload", {})
        account_id = int(payload.get("account_id", 0))
        credential_id = str(payload.get("credential_id", ""))
        target_platform = str(payload.get("platform", self.config.get("platform", "trae")))
        target = Path(self.config.get("credential_dir", "")).expanduser()
        token = str(self.config.get("agent_token", ""))
        ensure_dir(target)
        ensure_dir(self.snapshots)

        started = now_ms()
        had_previous = any(target.iterdir()) if target.exists() else False
        backup_dir = self.snapshots / f"{started}_{account_id}_{target_platform}"
        journal = {
            "phase": "backup",
            "command_id": command_id,
            "account_id": account_id,
            "platform": target_platform,
            "target_dir": str(target),
            "backup_dir": str(backup_dir) if had_previous else None,
        }
        self.journal_path.write_text(json.dumps(journal, ensure_ascii=False, indent=2), encoding="utf-8")
        try:
            files = Vault.import_from_agent(self.fetch_credential(credential_id), token)
            if had_previous:
                shutil.move(str(target), str(backup_dir))
                journal["phase"] = "restored"
                self.journal_path.write_text(json.dumps(journal, ensure_ascii=False, indent=2), encoding="utf-8")
            for name, content in files.items():
                relative = Path(name)
                if relative.is_absolute() or ".." in relative.parts:
                    continue
                destination = target / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(content)
            if not any(target.iterdir()):
                raise RuntimeError("credential validation failed: target directory empty")

            rotated = self._capture(target)
            if rotated:
                self.upload_credential(credential_id, Vault.wrap_files(rotated, token))

            context["active"][target_platform] = account_id
            context["phase"] = "committed"
            context["last_command_id"] = command_id
            context["account_id"] = account_id
            self.save_context(context)
            self.ack(command_id, "done", {"account_id": account_id, "platform": target_platform}, context)
            self.journal_path.unlink(missing_ok=True)
            self._mark_applied(command_id)
            self._cleanup_snapshots()
            return {"command_id": command_id, "ok": True, "account_id": account_id, "duration_ms": now_ms() - started}
        except Exception as exc:
            if journal.get("backup_dir"):
                shutil.rmtree(target, ignore_errors=True)
                shutil.move(str(journal["backup_dir"]), str(target))
            self.journal_path.unlink(missing_ok=True)
            context["phase"] = "failed"
            context["last_error"] = str(exc)
            self.save_context(context)
            self.ack(command_id, "failed", {"error": str(exc)}, context)
            return {"command_id": command_id, "ok": False, "error": str(exc)}

    def _cleanup_snapshots(self) -> None:
        keep = 5
        dirs = sorted([p for p in self.snapshots.iterdir() if p.is_dir()], key=lambda p: p.name) if self.snapshots.exists() else []
        for old in dirs[:-keep]:
            shutil.rmtree(old, ignore_errors=True)

    # ---------- loop ----------
    def run_once(self) -> dict[str, Any]:
        if not self.registered:
            raise RuntimeError("agent not registered")
        recovery = self.recover()
        context = self.load_context()
        self.heartbeat(context)
        commands = self.poll(int(context.get("last_seq", 0)))
        results = []
        for command in commands:
            results.append(self.execute_command(command))
            context = self.load_context()
            context["last_seq"] = max(int(context.get("last_seq", 0)), int(command.get("seq", 0)))
            self.save_context(context)
            self.heartbeat(context)
        return {"recovery": recovery, "commands": results, "last_seq": context.get("last_seq", 0)}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="aiops-agent", description="AIOpsHub Windows Agent")
    parser.add_argument("--home", help=f"agent data directory (default: {DEFAULT_HOME})")
    sub = parser.add_subparsers(dest="command", required=True)

    register = sub.add_parser("register", help="register this machine and save agent token")
    register.add_argument("--server", required=True, help="https://hub.example.com or http://127.0.0.1:8787")
    register.add_argument("--admin-key", required=True)
    register.add_argument("--machine-id", default=platform_lib.node())
    register.add_argument("--platform", default="trae")
    register.add_argument("--credential-dir", required=True)

    run = sub.add_parser("run", help="run the agent loop")
    run.add_argument("--once", action="store_true")
    run.add_argument("--interval", type=int, default=5)

    sub.add_parser("status", help="show local agent status")
    return parser


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    client = AgentClient(Path(args.home) if args.home else None)
    if args.command == "register":
        result = client.register(args.server, args.admin_key, args.machine_id, args.platform, args.credential_dir)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif args.command == "status":
        print(json.dumps({"config": client.config, "context": client.load_context()}, ensure_ascii=False, indent=2))
    elif args.command == "run":
        if args.once:
            print(json.dumps(client.run_once(), ensure_ascii=False, indent=2))
            return
        interval = max(1, args.interval)
        print(f"agent {client.config.get('agent_id')} running, poll every {interval}s")
        while True:
            try:
                print(json.dumps(client.run_once(), ensure_ascii=False))
            except Exception as exc:
                print(f"[agent] {exc}", file=sys.stderr)
            time.sleep(interval)


if __name__ == "__main__":
    main()
