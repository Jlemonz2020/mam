from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .service import Hub

WEB_DIR = Path(__file__).resolve().parents[2] / "web"


class HubHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], hub: Hub):
        super().__init__(address, Handler)
        self.hub = hub
        self.mock_state: dict[int, dict[str, int]] = {}
        self.mock_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server_version = "AIOpsHub/1.0"

    @property
    def hub(self) -> Hub:
        return self.server.hub  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[http] {self.address_string()} {fmt % args}")

    # ---------- helpers ----------
    def _send(self, status: int, payload: Any, content_type: str = "application/json; charset=utf-8") -> None:
        body = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key, X-Api-Key, X-Agent-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload: Any) -> None:
        self._send(status, payload)

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", 0))
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    def _authorized(self) -> bool:
        expected = str(self.hub.config.get("server.admin_key", "change-me-local-admin-key"))
        return self.headers.get("X-Admin-Key") == expected

    def _api_key(self) -> str:
        return self.headers.get("X-Api-Key") or self.headers.get("Authorization", "").removeprefix("Bearer ")

    def _agent_auth(self, agent_id: str) -> bool:
        token = self.headers.get("X-Agent-Token", "")
        return bool(agent_id) and self.hub.agents.authenticate(agent_id, token)

    def _query(self) -> dict[str, list[str]]:
        return parse_qs(urlparse(self.path).query)

    def _static(self, name: str) -> None:
        path = WEB_DIR / name
        if not path.exists():
            self._json(404, {"error": f"missing {name}"})
            return
        content_type = "text/html; charset=utf-8" if name.endswith(".html") else (
            "text/javascript; charset=utf-8" if name.endswith(".js") else "text/css; charset=utf-8"
        )
        self._send(200, path.read_bytes(), content_type)

    # ---------- routes ----------
    def do_OPTIONS(self) -> None:  # noqa: N802
        self._send(204, b"")

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        if path in ("/", "/index.html"):
            self._static("index.html")
            return
        if path in ("/app.js", "/styles.css"):
            self._static(path.lstrip("/"))
            return
        if path == "/api/doctor":
            self._json(200, self.hub.doctor())
            return
        if path.startswith("/api/") and not self._authorized():
            self._json(401, {"error": "invalid admin key"})
            return
        query = self._query()
        try:
            if path == "/api/summary":
                self._json(200, self.hub.summary())
            elif path == "/api/accounts":
                self._json(200, {"accounts": self.hub.list_accounts()})
            elif path == "/api/tasks":
                self._json(200, {"tasks": [task.to_dict() for task in self.hub.scheduler.list()]})
            elif path == "/api/records":
                kind = query.get("type", [None])[0]
                limit = int(query.get("limit", ["200"])[0])
                self._json(200, {"records": self.hub.events(limit, kind)})
            elif path == "/api/report":
                self._json(200, self.hub.report(query.get("month", [None])[0]))
            elif path == "/api/usage":
                self._json(200, self.hub.usage())
            elif path == "/api/health":
                self._json(200, {"items": self.hub.health()})
            elif path == "/api/adapters":
                self._json(200, {"adapters": self.hub.adapters.describe()})
            elif path == "/api/agents":
                self._json(200, self.hub.agents_summary())
            elif path == "/agent/commands/poll":
                agent_id = query.get("agent_id", [""])[0]
                if not self._agent_auth(agent_id):
                    self._json(401, {"error": "invalid agent token"})
                else:
                    since = int(query.get("since", ["0"])[0])
                    self._json(200, {"commands": self.hub.agents.poll(agent_id, since)})
            elif path == "/agent/context":
                agent_id = query.get("agent_id", [""])[0]
                if not self._agent_auth(agent_id):
                    self._json(401, {"error": "invalid agent token"})
                else:
                    self._json(200, {"context": self.hub.agents.context(agent_id)})
            elif path == "/agent/credentials":
                agent_id = query.get("agent_id", [""])[0]
                credential_id = query.get("credential_id", [""])[0]
                if not self._agent_auth(agent_id):
                    self._json(401, {"error": "invalid agent token"})
                else:
                    blob = self.hub.wrap_credential_for_agent(credential_id, self.headers.get("X-Agent-Token", ""))
                    self._json(200, {"credential_id": credential_id, "blob": blob})
            elif path in ("/v1/models", "/models"):
                self._json(200, {"object": "list", "data": [{"id": model, "object": "model"} for model in ("gpt-4o-mini", "claude-sonnet", "deepseek-chat")]})
            elif path in ("/v1/usage", "/usage"):
                self._json(200, self.hub.usage())
            else:
                self._json(404, {"error": "not found"})
        except Exception as exc:
            self._json(500, {"error": str(exc)})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        body = self._body()
        try:
            if path.startswith("/mock/") and not self.hub.config.get("server.enable_mock", True):
                self._json(404, {"error": "mock endpoints disabled"})
                return
            if path == "/mock/checkin":
                self._mock_checkin(body)
                return
            if path == "/mock/points":
                self._mock_points(body)
                return
            if path == "/mock/upstream":
                self._mock_upstream(body)
                return
            if path == "/agent/register":
                if not self._authorized():
                    self._json(401, {"error": "invalid admin key"})
                else:
                    self._json(
                        200,
                        self.hub.agents.register(
                            str(body.get("machine_id", "unknown")),
                            str(body.get("platform", "trae")),
                            str(body.get("credential_dir", "")),
                        ),
                    )
                return
            if path.startswith("/agent/"):
                agent_id = str(body.get("agent_id", ""))
                if not self._agent_auth(agent_id):
                    self._json(401, {"error": "invalid agent token"})
                    return
                token = self.headers.get("X-Agent-Token", "")
                if path == "/agent/heartbeat":
                    self._json(200, {"ok": True, "agent": self.hub.agents.heartbeat(agent_id, body.get("context") or {})})
                elif path == "/agent/commands/ack":
                    acked = self.hub.agents.ack(
                        agent_id,
                        str(body.get("command_id", "")),
                        str(body.get("status", "failed")),
                        body.get("result"),
                        body.get("context"),
                    )
                    self._json(200 if acked else 404, {"ok": bool(acked), "command": acked})
                elif path == "/agent/context":
                    self._json(200, {"ok": True, "context": self.hub.agents.save_context(agent_id, body.get("context") or {})})
                elif path == "/agent/credentials/upload":
                    count = self.hub.store_agent_credential(str(body.get("credential_id", "")), str(body.get("blob", "")), token)
                    self._json(200, {"ok": True, "files": count})
                else:
                    self._json(404, {"error": "not found"})
                return
            if path in ("/v1/chat/completions", "/chat/completions"):
                result = self.hub.gateway_request(self._api_key(), body.get("model", "gpt-4o-mini"), body.get("messages", []), self.client_address[0])
                self._json(result.get("status", 200), result)
                return
            if path.startswith("/api/") and not self._authorized():
                self._json(401, {"error": "invalid admin key"})
                return
            if path == "/api/init":
                self._json(200, self.hub.init(str(body.get("password", ""))))
            elif path == "/api/add":
                self._json(200, self.hub.add_account(str(body.get("name", "account")), str(body.get("platform", "trae")), body.get("groups") or []))
            elif path == "/api/switch":
                self._json(
                    200,
                    self.hub.switch(
                        int(body["account_id"]),
                        allow_while_running=bool(body.get("allow_while_running", False)),
                        agent_id=body.get("agent_id") or None,
                        prefer_agent=bool(body.get("prefer_agent", True)),
                    ),
                )
            elif path == "/api/checkin":
                self._json(200, self.hub.checkin(int(body["account_id"])))
            elif path == "/api/points":
                self._json(200, self.hub.points(int(body["account_id"])))
            elif path == "/api/task/run":
                self._json(200, {"results": self.hub.scheduler.run_due(body.get("type"))})
            else:
                self._json(404, {"error": "not found"})
        except Exception as exc:
            self._json(500, {"error": str(exc)})

    # ---------- local simulation endpoints ----------
    def _mock_checkin(self, body: dict[str, Any]) -> None:
        account_id = int(body.get("account_id", 0))
        with self.server.mock_lock:  # type: ignore[attr-defined]
            state = self.server.mock_state.setdefault(account_id, {"balance": 1000 + account_id * 7, "quota": 80})  # type: ignore[attr-defined]
            state["balance"] += 10
        self._json(200, {"status": "success", "reward": 10, "balance": state["balance"], "message": "mock check-in ok"})

    def _mock_points(self, body: dict[str, Any]) -> None:
        account_id = int(body.get("account_id", 0))
        with self.server.mock_lock:  # type: ignore[attr-defined]
            state = self.server.mock_state.setdefault(account_id, {"balance": 1000 + account_id * 7, "quota": 80})  # type: ignore[attr-defined]
        self._json(200, {"status": "success", "balance": state["balance"], "quota": state["quota"]})

    def _mock_upstream(self, body: dict[str, Any]) -> None:
        model = str(body.get("model", "gpt-4o-mini"))
        self._json(
            200,
            {
                "id": "chatcmpl-mock",
                "object": "chat.completion",
                "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": f"mock reply from {model}"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20},
            },
        )


def serve(home: Path | str | None = None, host: str | None = None, port: int | None = None, password: str | None = None) -> None:
    hub = Hub(home, password=password)
    address = (host or str(hub.config.get("server.host", "127.0.0.1")), int(port or hub.config.get("server.port", 8787)))
    server = HubHTTPServer(address, hub)
    hub.start_scheduler()
    print(f"AIOpsHub listening on http://{address[0]}:{address[1]}  admin_key={hub.config.get('server.admin_key')}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        hub.stop_scheduler()
        server.server_close()
