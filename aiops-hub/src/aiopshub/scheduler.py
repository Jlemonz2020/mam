from __future__ import annotations

import random
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from .models import TASK_TYPES, Task
from .storage import StateStore
from .util import now_ms

DEFAULT_TASKS: dict[str, Any] = {
    "version": 1,
    "tasks": [
        {
            "id": "daily-checkin",
            "type": "checkin",
            "name": "每日签到与保活",
            "enabled": True,
            "time": "09:00",
            "jitter_minutes": 30,
            "interval_hours": 0,
            "platforms": [],
            "groups": [],
        },
        {
            "id": "points-poll",
            "type": "points_poll",
            "name": "积分与额度巡检",
            "enabled": True,
            "time": "",
            "jitter_minutes": 0,
            "interval_hours": 6,
            "platforms": [],
            "groups": [],
        },
        {
            "id": "health-check",
            "type": "health_check",
            "name": "账号健康探测",
            "enabled": True,
            "time": "",
            "jitter_minutes": 0,
            "interval_hours": 24,
            "platforms": [],
            "groups": [],
        },
    ],
}


class Scheduler:
    """One scheduling center for check-in, keep-alive, wake-up, points and health tasks."""

    def __init__(self, hub: Any):
        self.hub = hub
        self.store = StateStore(Path(hub.home) / "tasks.json", DEFAULT_TASKS)
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._running = threading.Lock()

    def list(self) -> list[Task]:
        return [Task.from_dict(raw) for raw in self.store.load()["tasks"]]

    def save(self, tasks: list[Task]) -> None:
        state = self.store.load()
        state["tasks"] = [task.to_dict() for task in tasks]
        self.store.save(state)

    def add(self, task: Task) -> Task:
        tasks = self.list()
        tasks.append(task)
        self.save(tasks)
        return task

    def remove(self, task_id: str) -> bool:
        tasks = self.list()
        remaining = [t for t in tasks if t.id != task_id]
        if len(remaining) == len(tasks):
            return False
        self.save(remaining)
        return True

    def run_due(self, force_type: str | None = None) -> list[dict[str, Any]]:
        if not self._running.acquire(blocking=False):
            return [{"skipped": True, "reason": "scheduler busy"}]
        results: list[dict[str, Any]] = []
        try:
            now = time.time()
            today = datetime.fromtimestamp(now).strftime("%Y-%m-%d")
            for task in self.list():
                if not task.enabled or task.type not in TASK_TYPES:
                    continue
                if force_type and task.type != force_type:
                    continue
                due, reason = self._is_due(task, now, today)
                if not due and not force_type:
                    continue
                result = self._run_task(task)
                result["reason"] = reason if due else "forced"
                results.append(result)
                if not force_type:
                    task.last_run = int(now * 1000)
                    task.last_due = today
                    tasks = self.list()
                    for index, existing in enumerate(tasks):
                        if existing.id == task.id:
                            tasks[index] = task
                    self.save(tasks)
        finally:
            self._running.release()
        return results

    def _is_due(self, task: Task, now: float, today: str) -> tuple[bool, str]:
        if task.type == "checkin" and task.time:
            hour, minute = (int(part) for part in task.time.split(":")[:2])
            base = datetime.fromtimestamp(now).replace(hour=hour, minute=minute, second=0, microsecond=0).timestamp()
            jitter = random.randint(0, max(0, task.jitter_minutes)) * 60
            if now >= base + jitter and task.last_due != today:
                return True, f"daily {task.time}+{task.jitter_minutes}m"
            return False, "not due"
        if task.interval_hours > 0:
            elapsed = (now_ms() - task.last_run) / 3_600_000
            if elapsed >= task.interval_hours:
                return True, f"every {task.interval_hours}h"
            return False, "interval not reached"
        return False, "no trigger configured"

    def _run_task(self, task: Task) -> dict[str, Any]:
        accounts = [
            account
            for account in self.hub.pool.list()
            if (not task.platforms or account.platform in task.platforms)
            and (not task.groups or set(task.groups).intersection(account.groups))
        ]
        results = []
        for account in accounts:
            try:
                if task.type == "checkin":
                    results.append(self.hub.checkin(account.id, scheduled=True, task_type="checkin", auto_switch=True))
                elif task.type == "keepalive":
                    results.append(self.hub.keepalive(account.id))
                elif task.type == "wakeup":
                    results.append(self.hub.wakeup(account.id))
                elif task.type == "points_poll":
                    results.append(self.hub.points(account.id))
                elif task.type == "health_check":
                    results.append(self.hub.health_check(account.id))
            except Exception as exc:
                results.append({"account_id": account.id, "ok": False, "error": str(exc)})
        outcome = {"task": task.id, "type": task.type, "ok": all(r.get("ok", True) for r in results), "results": results}
        self.hub.records.append("task", outcome)
        return outcome

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()

        def loop() -> None:
            interval = int(self.hub.config.get("schedule.tick_seconds", 30))
            while not self._stop.is_set():
                try:
                    self.run_due()
                except Exception as exc:
                    self.hub.records.append("log", {"taskType": "scheduler", "status": "failed", "detail": str(exc)})
                self._stop.wait(max(1, interval))

        self._thread = threading.Thread(target=loop, name="aiops-scheduler", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
