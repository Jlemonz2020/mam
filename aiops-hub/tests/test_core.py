from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from aiopshub.models import Task  # noqa: E402
from aiopshub.scheduler import Scheduler  # noqa: E402
from aiopshub.service import Hub  # noqa: E402
from aiopshub.storage import StateStore  # noqa: E402
from aiopshub.vault import Vault  # noqa: E402


class FakeResponse:
    def __init__(self, payload: dict):
        self.payload = json.dumps(payload).encode("utf-8")

    def read(self) -> bytes:
        return self.payload

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class TestVault(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_encrypt_decrypt_and_wrong_password(self):
        vault = Vault(self.home)
        vault.initialize("secret123")
        vault.unlock("secret123")
        vault.put("cred-1", {"auth.json": b'{"token":"abc"}'})
        self.assertEqual(vault.get("cred-1")["auth.json"], b'{"token":"abc"}')
        vault.lock()
        with self.assertRaises(RuntimeError):
            vault.unlock("wrong-password")

    def test_machine_master_key(self):
        vault = Vault(self.home)
        vault.initialize("secret123")
        self.assertIsNotNone(vault.resolve_password())


class TestStorage(unittest.TestCase):
    def test_atomic_checksum_and_backup_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            store = StateStore(path, {"version": 1, "value": "init"})
            store.save({"version": 1, "value": "first"})
            store.save({"version": 1, "value": "second"})
            raw = json.loads(path.read_text(encoding="utf-8"))
            raw["checksum"] = "tampered"
            path.write_text(json.dumps(raw), encoding="utf-8")
            self.assertEqual(store.load()["value"], "first")
            self.assertTrue(any(p.name.startswith("state.json.corrupt-") for p in Path(tmp).iterdir()))


class TestHubFlows(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.hub = Hub(self.home)
        self.hub.init("secret123")
        directory = self.hub.config.adapter_dir("trae")
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "storage.json").write_text(json.dumps({"token": "token-trae", "device_id": "dev-1"}), encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_account_pool_and_selection(self):
        first = self.hub.add_account("A", "trae", ["工作"])
        second = self.hub.add_account("B", "trae", ["生活"])
        self.assertEqual(len(self.hub.list_accounts()), 2)
        self.hub.pool.set_active("trae", first["id"])
        selected = self.hub.pool.select("trae", "round-robin")
        self.assertEqual(selected.id, second["id"])

    def test_checkin_is_idempotent_per_day(self):
        account = self.hub.add_account("A", "trae")
        with patch.object(self.hub.adapters, "checkin", return_value={"status": "success", "reward": 10, "balance": 100, "message": None}):
            first = self.hub.checkin(account["id"])
            second = self.hub.checkin(account["id"])
        self.assertEqual(first["status"], "success")
        self.assertEqual(second["status"], "skipped")
        self.assertEqual(summary_reward(self.hub), 10)

    def test_switch_rollback_restores_login_state(self):
        first = self.hub.add_account("A", "trae")
        second = self.hub.add_account("B", "trae")
        self.hub.switch(first["id"])
        original = (self.hub.config.adapter_dir("trae") / "storage.json").read_bytes()
        self.hub.vault.put(second["credential_id"], {"storage.json": b'{"token":"NEW-TOKEN"}'})
        with patch.object(self.hub.adapters, "apply", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                self.hub.switch(second["id"])
        self.assertEqual((self.hub.config.adapter_dir("trae") / "storage.json").read_bytes(), original)
        self.assertEqual(self.hub.pool.active("trae"), first["id"])

    def test_switch_recovery_from_journal(self):
        self.hub.add_account("A", "trae")
        target = self.hub.config.adapter_dir("trae")
        original = (target / "storage.json").read_bytes()
        backup_dir = self.hub.home / "backups" / "manual-backup"
        backup_dir.parent.mkdir(parents=True, exist_ok=True)
        target.rename(backup_dir)
        target.mkdir(parents=True)
        (target / "storage.json").write_text('{"token":"partial"}', encoding="utf-8")
        self.hub.switcher.journal.write_text(
            json.dumps({"phase": "restored", "platform": "trae", "target_dir": str(target), "backup_dir": str(backup_dir)}),
            encoding="utf-8",
        )
        result = self.hub.switcher.recover()
        self.assertTrue(result["recovered"])
        self.assertFalse(self.hub.switcher.journal.exists())
        self.assertEqual((target / "storage.json").read_bytes(), original)

    def test_gateway_auth_routing_and_usage(self):
        self.hub.add_account("A", "trae")
        bad = self.hub.gateway_request("wrong-key", "gpt-4o-mini", [])
        self.assertFalse(bad["ok"])
        with patch("aiopshub.service.urllib.request.urlopen", return_value=FakeResponse({"usage": {"total_tokens": 20}, "choices": []})):
            good = self.hub.gateway_request("local-demo-key", "gpt-4o-mini", [{"role": "user", "content": "hi"}])
        self.assertTrue(good["ok"])
        self.assertEqual(good["status"], 200)
        self.assertEqual(self.hub.usage()["calls"], 1)

    def test_scheduler_due_logic(self):
        scheduler = Scheduler(self.hub)
        task = Task(id="t", type="checkin", name="t", time="00:00", jitter_minutes=0)
        due, _ = scheduler._is_due(task, time.time(), "2026-11-23")
        self.assertTrue(due)


def summary_reward(hub: Hub) -> int:
    return int(hub.summary()["today"]["reward"])


if __name__ == "__main__":
    unittest.main()
