from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from .util import now_ms

ACCOUNT_STATUSES = ("active", "paused", "invalid", "banned")
TASK_TYPES = ("checkin", "keepalive", "wakeup", "points_poll", "health_check")


@dataclass
class Account:
    id: int
    name: str
    platform: str
    credential_id: str
    status: str = "active"
    groups: list[str] = field(default_factory=list)
    health: str = "unknown"
    points: int = 0
    quota: int = 0
    remark: str = ""
    created_at: int = field(default_factory=now_ms)
    updated_at: int = field(default_factory=now_ms)
    deleted_at: int | None = None
    last_checkin_date: str = ""
    fail_streak: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "Account":
        allowed = {k: v for k, v in raw.items() if k in cls.__dataclass_fields__}
        return cls(**allowed)


@dataclass
class Task:
    id: str
    type: str
    name: str
    enabled: bool = True
    time: str = "09:00"
    jitter_minutes: int = 0
    interval_hours: int = 0
    platforms: list[str] = field(default_factory=list)
    groups: list[str] = field(default_factory=list)
    last_run: int = 0
    last_due: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "Task":
        allowed = {k: v for k, v in raw.items() if k in cls.__dataclass_fields__}
        return cls(**allowed)


def new_account(account_id: int, name: str, platform: str, credential_id: str, **extra: Any) -> Account:
    return Account(id=account_id, name=name, platform=platform, credential_id=credential_id, **extra)
