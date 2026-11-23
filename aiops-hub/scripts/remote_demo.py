#!/usr/bin/env python3
"""Cross-process demo: server CLI + HTTP dispatch + Windows Agent CLI."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOME = ROOT / "remote-demo-data"
AGENT_HOME = ROOT / "remote-agent-home"
PORT = 8791
BASE = f"http://127.0.0.1:{PORT}"
ADMIN_KEY = "change-me-local-admin-key"
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ENV = os.environ.copy()
ENV["PYTHONIOENCODING"] = "utf-8"


def run(args: list[str]) -> str:
    result = subprocess.run([sys.executable, *args], cwd=ROOT, env=ENV, text=True, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(f"command failed: {args}\n{result.stdout}\n{result.stderr}")
    return result.stdout


def request(path: str, body: dict | None = None, headers: dict | None = None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers=headers or {}, method="POST" if data else "GET")
    with urllib.request.urlopen(req, timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


def wait_ready() -> None:
    for _ in range(50):
        try:
            request("/api/doctor")
            return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError("server did not become ready")


def main() -> None:
    for path in (HOME, AGENT_HOME):
        shutil.rmtree(path, ignore_errors=True)

    print("1) 初始化服务器数据目录与凭据库")
    print(run(["run.py", "--home", str(HOME), "init", "--password", "remote-pass-123"]).strip())

    print("2) 准备服务端演示登录态并添加账号")
    credential_dir = HOME / "fake-clients" / "trae"
    credential_dir.mkdir(parents=True, exist_ok=True)
    (credential_dir / "storage.json").write_text(json.dumps({"token": "remote-token", "device_id": "remote-dev"}), encoding="utf-8")
    added = json.loads(run(["run.py", "--home", str(HOME), "add", "--name", "远程号A", "--platform", "trae", "--groups", "测试"]))
    account_id = added["id"]
    print("account_id:", account_id)

    print("3) 启动服务器进程")
    log_path = ROOT / "remote-server.log"
    with log_path.open("w", encoding="utf-8") as log:
        server = subprocess.Popen(
            [sys.executable, "run.py", "--home", str(HOME), "serve", "--host", "127.0.0.1", "--port", str(PORT)],
            cwd=ROOT,
            env=ENV,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
    try:
        wait_ready()
        print("server ready:", BASE)

        print("4) Windows Agent 注册")
        target = AGENT_HOME / "client" / "trae"
        target.mkdir(parents=True, exist_ok=True)
        (target / "old.txt").write_text("previous login state", encoding="utf-8")
        registered = json.loads(
            run(
                [
                    "agent/agent.py", "--home", str(AGENT_HOME), "register",
                    "--server", BASE, "--admin-key", ADMIN_KEY,
                    "--machine-id", "WIN-DEMO-01", "--platform", "trae", "--credential-dir", str(target),
                ]
            )
        )
        print("agent_id:", registered["agent_id"])

        print("5) 通过 HTTP 下发自动切换命令")
        dispatched = request("/api/switch", {"account_id": account_id, "prefer_agent": True}, {"X-Admin-Key": ADMIN_KEY})
        print(json.dumps(dispatched, ensure_ascii=False, indent=2))
        assert dispatched.get("dispatched") is True

        print("6) Agent 单次轮询并执行本地事务切换")
        outcome = json.loads(run(["agent/agent.py", "--home", str(AGENT_HOME), "run", "--once"]))
        print(json.dumps(outcome, ensure_ascii=False, indent=2))
        assert outcome["commands"][0]["ok"] is True

        print("7) 校验服务端命令状态与上下文")
        summary = request("/api/agents", headers={"X-Admin-Key": ADMIN_KEY})
        command = next(c for c in summary["commands"] if c["id"] == dispatched["command_id"])
        assert command["status"] == "done"
        assert summary["agents"][0]["online"] is True
        assert summary["agents"][0]["context"]["active"]["trae"] == account_id
        assert summary["agents"][0]["context"]["last_seq"] >= command["seq"]
        assert (target / "storage.json").exists()
        print(json.dumps({"command": {k: command[k] for k in ("id", "status", "seq")}, "context": summary["agents"][0]["context"]}, ensure_ascii=False, indent=2))
        print("\nREMOTE DEMO OK")
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
        print("server log:", log_path)


if __name__ == "__main__":
    main()
