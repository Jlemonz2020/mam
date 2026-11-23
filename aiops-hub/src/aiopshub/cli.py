from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .service import Hub


def _print(data: Any) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2, default=str))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="aiops", description="AIOpsHub unified AI account operations hub")
    parser.add_argument("--home", help="data directory (default: ./data or AIOPS_HOME)")
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init", help="initialize the encrypted vault")
    init.add_argument("--password", required=True)

    add = sub.add_parser("add", help="add an account to the unified pool")
    add.add_argument("--name", required=True)
    add.add_argument("--platform", required=True, choices=["trae", "codebuddy", "workbuddy", "qoder"])
    add.add_argument("--groups", default="")

    sub.add_parser("list", help="list accounts")
    switch = sub.add_parser("switch", help="transactional account switching")
    switch.add_argument("account_id", type=int)
    switch.add_argument("--password")
    switch.add_argument("--allow-while-running", action="store_true")

    checkin = sub.add_parser("checkin", help="run check-in")
    checkin.add_argument("account_id", type=int, nargs="?")
    checkin.add_argument("--all", action="store_true")
    checkin.add_argument("--scheduled", action="store_true")

    points = sub.add_parser("points", help="refresh points/quota")
    points.add_argument("account_id", type=int)

    report = sub.add_parser("report", help="monthly report")
    report.add_argument("--month")

    task = sub.add_parser("task", help="unified scheduler")
    task.add_argument("action", choices=["list", "run"])
    task.add_argument("--type", choices=["checkin", "keepalive", "wakeup", "points_poll", "health_check"])

    serve = sub.add_parser("serve", help="start local web console, API and scheduler")
    serve.add_argument("--host")
    serve.add_argument("--port", type=int)
    serve.add_argument("--no-scheduler", action="store_true")

    sub.add_parser("doctor", help="environment diagnostics")
    sub.add_parser("summary", help="unified dashboard summary")
    sub.add_parser("usage", help="gateway usage")
    return parser


def _hub(args: argparse.Namespace) -> Hub:
    return Hub(args.home)


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    hub = _hub(args)

    if args.command == "init":
        _print(hub.init(args.password))
    elif args.command == "add":
        hub.unlock()
        groups = [g.strip() for g in args.groups.split(",") if g.strip()]
        _print(hub.add_account(args.name, args.platform, groups))
    elif args.command == "list":
        _print({"accounts": hub.list_accounts()})
    elif args.command == "switch":
        _print(hub.switch(args.account_id, args.password, args.allow_while_running))
    elif args.command == "checkin":
        ids: list[int] = []
        if args.all:
            ids = [account.id for account in hub.pool.list()]
        elif args.account_id is not None:
            ids = [args.account_id]
        else:
            print("provide account_id or --all", file=sys.stderr)
            raise SystemExit(2)
        _print([hub.checkin(account_id, scheduled=args.scheduled) for account_id in ids])
    elif args.command == "points":
        _print(hub.points(args.account_id))
    elif args.command == "report":
        _print(hub.report(args.month))
    elif args.command == "task":
        if args.action == "list":
            _print({"tasks": [task.to_dict() for task in hub.scheduler.list()]})
        else:
            _print({"results": hub.scheduler.run_due(args.type)})
    elif args.command == "serve":
        if not args.no_scheduler:
            hub.start_scheduler()
        from .server import HubHTTPServer

        host = args.host or str(hub.config.get("server.host", "127.0.0.1"))
        port = args.port or int(hub.config.get("server.port", 8787))
        server = HubHTTPServer((host, port), hub)
        print(f"AIOpsHub listening on http://{host}:{port}  admin_key={hub.config.get('server.admin_key')}")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            hub.stop_scheduler()
            server.server_close()
    elif args.command == "doctor":
        _print(hub.doctor())
    elif args.command == "summary":
        _print(hub.summary())
    elif args.command == "usage":
        _print(hub.usage())


if __name__ == "__main__":
    main()
