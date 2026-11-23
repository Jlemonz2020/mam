from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any

from .accounts import AccountPool
from .storage import RecordsStore
from .util import iso, now_ms


class Observer:
    """Unified metrics, dashboards, reports and diagnostics."""

    def __init__(self, pool: AccountPool, records: RecordsStore):
        self.pool = pool
        self.records = records

    def summary(self) -> dict[str, Any]:
        accounts = self.pool.list()
        today = datetime.now().strftime("%Y-%m-%d")
        checkins = [r for r in self.records.read(5000, "checkin") if r["r"].get("checkinDate") == today]
        snapshots = self.records.read(5000, "snapshot")
        latest: dict[int, int] = {}
        for record in snapshots:
            account_id = record["r"].get("accountId")
            if account_id is not None:
                latest[int(account_id)] = int(record["r"].get("balance", 0))
        events = self.records.read(20, "event")
        return {
            "generated_at": iso(),
            "accounts": {
                "total": len(accounts),
                "by_status": dict(Counter(a.status for a in accounts)),
                "by_platform": dict(Counter(a.platform for a in accounts)),
            },
            "today": {
                "success": sum(1 for r in checkins if r["r"].get("status") == "success"),
                "skipped": sum(1 for r in checkins if r["r"].get("status") == "skipped"),
                "failed": sum(1 for r in checkins if r["r"].get("status") == "failed"),
                "reward": sum(int(r["r"].get("reward", 0)) for r in checkins),
            },
            "points_total": sum(latest.values()),
            "active": {a.platform: a.id for a in accounts if self.pool.active(a.platform) == a.id},
            "recent_events": [r["r"] for r in events[-8:]],
        }

    def report(self, month: str | None = None) -> dict[str, Any]:
        month = month or datetime.now().strftime("%Y-%m")
        per_account: dict[int, dict[str, Any]] = defaultdict(lambda: {"success": 0, "failed": 0, "skipped": 0, "reward": 0})
        for record in self.records.read(20000, "checkin"):
            date = str(record["r"].get("checkinDate", ""))
            if not date.startswith(month):
                continue
            account_id = int(record["r"].get("accountId", 0))
            status = record["r"].get("status", "failed")
            per_account[account_id][status] = per_account[account_id].get(status, 0) + 1
            per_account[account_id]["reward"] += int(record["r"].get("reward", 0) or 0)
        return {"month": month, "accounts": dict(per_account)}

    def usage(self, limit: int = 200) -> dict[str, Any]:
        records = self.records.read(limit, "gateway")
        by_key: dict[str, int] = Counter()
        by_model: dict[str, int] = Counter()
        total_tokens = 0
        for record in records:
            payload = record["r"]
            by_key[str(payload.get("key_name", "unknown"))] += 1
            by_model[str(payload.get("model", "unknown"))] += 1
            total_tokens += int(payload.get("tokens", 0) or 0)
        return {"calls": len(records), "tokens": total_tokens, "by_key": dict(by_key), "by_model": dict(by_model), "recent": [r["r"] for r in records[-20:]]}

    def health(self) -> list[dict[str, Any]]:
        result = []
        for account in self.pool.list():
            result.append(
                {
                    "id": account.id,
                    "name": account.name,
                    "platform": account.platform,
                    "status": account.status,
                    "health": account.health,
                    "fail_streak": account.fail_streak,
                    "last_checkin_date": account.last_checkin_date,
                    "points": account.points,
                    "quota": account.quota,
                }
            )
        return result
