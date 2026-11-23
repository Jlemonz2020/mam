from __future__ import annotations

import json
import urllib.request
from typing import Any

from .config import HubConfig
from .storage import RecordsStore
from .util import iso


class NotifyCenter:
    """Single notification center: all alerts are logged and optionally webhooked."""

    LEVELS = ("info", "warning", "error")

    def __init__(self, config: HubConfig, records: RecordsStore):
        self.config = config
        self.records = records

    def emit(self, event: str, message: str, level: str = "info", account_id: int | None = None, **extra: Any) -> dict[str, Any]:
        subscribed = self.config.get("notify.on", []) or []
        if event not in subscribed and level == "info":
            return {"sent": [], "skipped": True}
        payload = {
            "event": event,
            "level": level,
            "message": message,
            "account_id": account_id,
            "at": iso(),
            **extra,
        }
        self.records.append("event", payload)
        sent = ["log"]
        channels = self.config.get("notify.channels", []) or []
        url = self.config.get("notify.webhook_url", "")
        if "webhook" in channels and url:
            try:
                request = urllib.request.Request(
                    str(url),
                    data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(request, timeout=3):
                    sent.append("webhook")
            except Exception as exc:
                self.records.append("event", {"event": "notify_failed", "level": "error", "message": str(exc)})
        return {"sent": sent, "skipped": False, "payload": payload}
