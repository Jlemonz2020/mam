from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from .accounts import AccountPool
from .adapters import AdapterManager
from .config import HubConfig
from .notify import NotifyCenter
from .storage import RecordsStore
from .util import FileLock, ensure_dir, now_ms, read_json

PHASES = ("backup", "restored", "committed")


class Switcher:
    """Transactional login-state switching with journal, backup and automatic rollback."""

    def __init__(
        self,
        home: Path,
        config: HubConfig,
        pool: AccountPool,
        adapters: AdapterManager,
        records: RecordsStore,
        notify: NotifyCenter,
    ):
        self.home = home
        self.config = config
        self.pool = pool
        self.adapters = adapters
        self.records = records
        self.notify = notify
        self.journal = home / "switch.journal.json"
        self.backups = home / "backups"

    def recover(self) -> dict[str, Any] | None:
        data = read_json(self.journal, {})
        phase = data.get("phase")
        if not phase:
            return None
        result: dict[str, Any] = {"phase": phase, "recovered": False}
        if phase == "committed":
            self.journal.unlink(missing_ok=True)
            result["recovered"] = True
            return result
        platform = data.get("platform", "")
        target = Path(data.get("target_dir", "")) if data.get("target_dir") else None
        backup = Path(data.get("backup_dir", "")) if data.get("backup_dir") else None
        if backup and backup.exists() and target:
            shutil.rmtree(target, ignore_errors=True)
            shutil.move(str(backup), str(target))
            result["recovered"] = True
            result["action"] = "restored backup"
        else:
            result["action"] = "backup missing; manual attention required"
        self.records.append(
            "log",
            {"taskType": "recovery", "status": "ok" if result["recovered"] else "warning", "detail": json.dumps(result)},
        )
        self.journal.unlink(missing_ok=True)
        return result

    def switch(self, account_id: int, password: str | None = None, allow_while_running: bool = False) -> dict[str, Any]:
        with FileLock(self.home / "switch.lock", ttl_seconds=60):
            self.recover()
            account = self.pool.get(account_id)
            if not account:
                raise ValueError(f"account {account_id} not found")
            if account.status != "active" or account.deleted_at:
                raise ValueError(f"account {account_id} is not active")
            platform = account.platform
            target = self.config.adapter_dir(platform)
            if target.exists() and any(target.iterdir()) and not allow_while_running:
                if self.config.get("switch.allow_while_running", False) is not True:
                    # The client being open is simulated by a marker file.
                    if (target / ".running").exists():
                        raise RuntimeError("client is running; stop it before switching (or use --allow-while-running)")

            from .service import Hub  # local import avoids a circular dependency

            hub = Hub(self.home, password=password)
            hub.vault.unlock(password)
            files = hub.vault.get(account.credential_id)
            if not files:
                raise RuntimeError(f"credential {account.credential_id} not found in vault")

            ensure_dir(self.backups)
            stamp = now_ms()
            backup_dir = self.backups / f"{stamp}_{account_id}_{platform}"
            had_previous = target.exists() and any(target.iterdir())
            journal = {
                "phase": "backup",
                "accountId": account_id,
                "platform": platform,
                "target_dir": str(target),
                "backup_dir": str(backup_dir) if had_previous else None,
                "createdAt": stamp,
            }
            self._write_journal(journal)
            try:
                if had_previous:
                    shutil.move(str(target), str(backup_dir))
                    journal["phase"] = "restored"
                    self._write_journal(journal)

                self.adapters.apply(platform, files, target)
                if not any(target.iterdir()):
                    raise RuntimeError("credential validation failed: target directory is empty")

                # Token rotation: re-capture the applied state and persist it.
                rotated = self.adapters.capture(platform)
                if rotated:
                    hub.vault.put(account.credential_id, rotated)

                self.pool.set_active(platform, account_id)
                self.pool.update(account_id, health="healthy", fail_streak=0)
                journal["phase"] = "committed"
                self._write_journal(journal)
                self.records.append(
                    "log",
                    {
                        "taskType": "switch",
                        "accountId": account_id,
                        "status": "ok",
                        "detail": json.dumps({"platform": platform, "backup": str(backup_dir)}, ensure_ascii=False),
                        "startedAt": stamp,
                        "durationMs": now_ms() - stamp,
                    },
                )
                self._cleanup_backups()
                self.journal.unlink(missing_ok=True)
                return {"ok": True, "account_id": account_id, "platform": platform, "backup": str(backup_dir) if had_previous else None}
            except Exception as exc:
                if journal.get("backup_dir"):
                    shutil.rmtree(target, ignore_errors=True)
                    shutil.move(str(journal["backup_dir"]), str(target))
                self.journal.unlink(missing_ok=True)
                self.records.append(
                    "log",
                    {"taskType": "switch", "accountId": account_id, "status": "failed", "detail": str(exc), "startedAt": stamp, "durationMs": now_ms() - stamp},
                )
                self.notify.emit("switch_failed", f"switch account #{account_id} failed: {exc}", "error", account_id)
                raise

    def _write_journal(self, data: dict[str, Any]) -> None:
        self.journal.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def _cleanup_backups(self) -> None:
        keep = int(self.config.get("switch.backup_keep", 5))
        dirs = sorted([p for p in self.backups.iterdir() if p.is_dir()], key=lambda p: p.name) if self.backups.exists() else []
        for old in dirs[:-keep]:
            shutil.rmtree(old, ignore_errors=True)
