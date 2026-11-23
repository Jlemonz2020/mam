from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "agent"))

from agent import AgentClient  # noqa: E402
from aiopshub.agents import AgentRegistry  # noqa: E402
from aiopshub.config import HubConfig  # noqa: E402
from aiopshub.server import HubHTTPServer  # noqa: E402
from aiopshub.service import Hub  # noqa: E402
from aiopshub.vault import Vault  # noqa: E402


class TestAgentRegistry(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.config = HubConfig(self.home)
        self.registry = AgentRegistry(self.home, self.config)

    def tearDown(self):
        self.tmp.cleanup()

    def test_register_auth_heartbeat_and_commands(self):
        registered = self.registry.register("win-01", "trae", "C:/clients/trae")
        agent_id = registered["agent_id"]
        token = registered["agent_token"]
        self.assertTrue(self.registry.authenticate(agent_id, token))
        self.assertFalse(self.registry.authenticate(agent_id, "wrong"))

        self.registry.heartbeat(agent_id, {"last_seq": 3, "active": {"trae": 7}, "phase": "idle"})
        self.assertEqual(self.registry.context(agent_id)["last_seq"], 3)
        self.assertEqual(len(self.registry.online_agents("trae")), 1)
        self.assertEqual(len(self.registry.online_agents("codebuddy")), 0)

        command = self.registry.dispatch(agent_id, {"type": "switch", "payload": {"account_id": 7}})
        polled = self.registry.poll(agent_id, 0)
        self.assertEqual(len(polled), 1)
        self.assertEqual(polled[0]["id"], command["id"])
        self.assertEqual(self.registry.poll(agent_id, 0), [])
        acked = self.registry.ack(agent_id, command["id"], "done", {"ok": True}, {"last_seq": command["seq"]})
        self.assertIsNotNone(acked)
        self.assertEqual(acked["status"], "done")
        self.assertNotIn("token_hash", self.registry.summary()["agents"][0])


class TestAgentTransport(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.hub = Hub(self.home)
        self.hub.init("secret123")
        self.account = self.hub.add_account("A", "trae", ["工作"])
        self.server = HubHTTPServer(("127.0.0.1", 0), self.hub)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def _post(self, path: str, body: dict, headers: dict | None = None):
        request = urllib.request.Request(
            self.base + path,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", **(headers or {})},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read().decode("utf-8"))

    def _get(self, path: str, headers: dict | None = None):
        request = urllib.request.Request(self.base + path, headers=headers or {})
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read().decode("utf-8"))

    def test_credential_wrap_roundtrip(self):
        token = "agent-token-large-random-value"
        blob = self.hub.wrap_credential_for_agent(self.account["credential_id"], token)
        restored = Vault.import_from_agent(blob, token)
        expected = self.hub.vault.get(self.account["credential_id"])
        self.assertEqual(restored, expected)

    def test_register_requires_admin_key(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self._post("/agent/register", {"machine_id": "m1", "platform": "trae"})
        self.assertEqual(ctx.exception.code, 401)

    def test_agent_full_loop(self):
        client_home = self.home / "agent-client"
        target_dir = self.home / "windows-client" / "trae"
        client = AgentClient(client_home)
        admin_key = str(self.hub.config.get("server.admin_key"))
        registered = client.register(self.base, admin_key, "win-01", "trae", str(target_dir))

        command = self.hub.agents.dispatch(
            registered["agent_id"],
            {
                "type": "switch",
                "payload": {
                    "account_id": self.account["id"],
                    "platform": "trae",
                    "credential_id": self.account["credential_id"],
                },
            },
        )
        outcome = client.run_once()
        self.assertEqual(len(outcome["commands"]), 1)
        self.assertTrue(outcome["commands"][0]["ok"])

        commands = {item["id"]: item for item in self.hub.agents.commands()}
        self.assertEqual(commands[command["id"]]["status"], "done")
        self.assertEqual(self.hub.agents.context(registered["agent_id"])["last_seq"], command["seq"])
        self.assertEqual(client.load_context()["active"]["trae"], self.account["id"])
        self.assertTrue(any(target_dir.iterdir()))

        # Replaying the same command must be idempotent.
        replay = client.execute_command(command)
        self.assertTrue(replay.get("skipped"))
        self.assertEqual(len(self.hub.agents.commands()), 1)

    def test_hub_switch_dispatches_to_online_agent(self):
        registered = self.hub.agents.register("win-02", "trae")
        self.hub.agents.heartbeat(registered["agent_id"], {"last_seq": 0, "active": {}})
        result = self.hub.switch(self.account["id"], prefer_agent=True)
        self.assertTrue(result["dispatched"])
        self.assertEqual(result["agent_id"], registered["agent_id"])
        self.assertEqual(len(self.hub.agents.commands()), 1)

    def test_mock_can_be_disabled_by_config(self):
        self.hub.config.data["server"]["enable_mock"] = False
        self.hub.config.save()
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self._post("/mock/checkin", {"account_id": 1})
        self.assertEqual(ctx.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
