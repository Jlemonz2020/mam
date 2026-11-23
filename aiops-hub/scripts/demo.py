#!/usr/bin/env python3
"""End-to-end runnable demonstration of the fused hub."""
from __future__ import annotations

import json
import shutil
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from aiopshub.server import HubHTTPServer  # noqa: E402
from aiopshub.service import Hub  # noqa: E402


def line(title: str) -> None:
    print(f"\n=== {title} ===")


def main() -> None:
    home = ROOT / "demo-data"
    if home.exists():
        shutil.rmtree(home)
    password = "demo-pass-123"

    hub = Hub(home)
    print("home:", hub.home)
    line("1. 初始化加密凭据库")
    print(json.dumps(hub.init(password), ensure_ascii=False))

    line("2. 模拟客户端登录态目录")
    for platform, cfg in hub.adapters.adapters.items():
        directory = hub.config.adapter_dir(platform)
        directory.mkdir(parents=True, exist_ok=True)
        token_file = cfg.get("token_file") or "auth.json"
        (directory / token_file).write_text(
            json.dumps({"token": f"token-{platform}", "device_id": f"device-{platform}"}), encoding="utf-8"
        )
        print("created", directory / token_file)

    line("3. 启动本地服务（含模拟签到/积分/上游接口）")
    port = int(hub.config.get("server.port", 8787))
    server = HubHTTPServer(("127.0.0.1", port), hub)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    hub.start_scheduler()
    time.sleep(0.4)

    line("4. 多平台账号纳管")
    a1 = hub.add_account("Trae 工作号", "trae", ["工作"])
    a2 = hub.add_account("CodeBuddy 测试号", "codebuddy", ["测试"])
    print(json.dumps([a1, a2], ensure_ascii=False, indent=2))

    line("5. 统一调度：执行签到任务（幂等）")
    first = hub.scheduler.run_due("checkin")
    second = hub.checkin(a1["id"])
    print("first:", json.dumps(first, ensure_ascii=False))
    print("second:", json.dumps(second, ensure_ascii=False, indent=2))

    line("6. 事务化切换 + 活跃指针")
    switched = hub.switch(a2["id"])
    print(json.dumps(switched, ensure_ascii=False, indent=2))
    print("active:", {p: hub.pool.active(p) for p in ("trae", "codebuddy")})

    line("7. 统一网关调用（鉴权/路由/用量）")
    gateway = hub.gateway_request("local-demo-key", "gpt-4o-mini", [{"role": "user", "content": "hello"}])
    print(json.dumps(gateway, ensure_ascii=False, indent=2))

    line("8. 看板、报表与自检")
    print("summary:", json.dumps(hub.summary(), ensure_ascii=False, indent=2))
    print("usage:", json.dumps(hub.usage(), ensure_ascii=False, indent=2))
    print("doctor ok:", hub.doctor()["ok"])

    line("9. 通过 HTTP 访问统一控制台")
    import urllib.request

    admin_key = str(hub.config.get("server.admin_key", "change-me-local-admin-key"))
    api_request = urllib.request.Request(f"http://127.0.0.1:{port}/api/summary", headers={"X-Admin-Key": admin_key})
    with urllib.request.urlopen(api_request, timeout=3) as response:
        print("GET /api/summary ->", response.status, response.read().decode("utf-8")[:160])
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=3) as response:
        print("GET / ->", response.status, "html bytes:", len(response.read()))

    hub.stop_scheduler()
    server.shutdown()
    server.server_close()
    print("\nDemo finished. Data kept at:", home)


if __name__ == "__main__":
    main()
