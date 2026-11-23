from __future__ import annotations

from pathlib import Path
from typing import Any, Iterable

from .models import ACCOUNT_STATUSES, Account
from .storage import StateStore
from .util import now_ms

DEFAULT_STATE: dict[str, Any] = {
    "version": 1,
    "accounts": [],
    "groups": [],
    "active": {},
    "seq": {"account": 0, "group": 0},
}


class AccountPool:
    """Single source of truth for accounts, groups, health and active pointers."""

    def __init__(self, home: Path):
        self.store = StateStore(home / "accounts.json", DEFAULT_STATE)

    def load(self) -> dict[str, Any]:
        return self.store.load()

    def save(self, state: dict[str, Any]) -> None:
        self.store.save(state)

    def add(self, name: str, platform: str, credential_id: str, groups: Iterable[str] = (), **extra: Any) -> Account:
        state = self.load()
        state["seq"]["account"] += 1
        account = Account(
            id=state["seq"]["account"],
            name=name,
            platform=platform,
            credential_id=credential_id,
            groups=list(groups),
            **extra,
        )
        state["accounts"].append(account.to_dict())
        for group in account.groups:
            if group not in state["groups"]:
                state["groups"].append(group)
        self.save(state)
        return account

    def get(self, account_id: int) -> Account | None:
        state = self.load()
        for raw in state["accounts"]:
            if raw.get("id") == account_id:
                return Account.from_dict(raw)
        return None

    def list(self, include_deleted: bool = False) -> list[Account]:
        state = self.load()
        items = [Account.from_dict(raw) for raw in state["accounts"]]
        if not include_deleted:
            items = [item for item in items if item.deleted_at is None]
        return items

    def update(self, account_id: int, **changes: Any) -> Account | None:
        state = self.load()
        for raw in state["accounts"]:
            if raw.get("id") == account_id:
                if "status" in changes and changes["status"] not in ACCOUNT_STATUSES:
                    raise ValueError(f"invalid status: {changes['status']}")
                raw.update(changes)
                raw["updated_at"] = now_ms()
                self.save(state)
                return Account.from_dict(raw)
        return None

    def remove(self, account_id: int, hard: bool = False) -> bool:
        state = self.load()
        if hard:
            state["accounts"] = [a for a in state["accounts"] if a.get("id") != account_id]
        else:
            for raw in state["accounts"]:
                if raw.get("id") == account_id:
                    raw["deleted_at"] = now_ms()
                    raw["updated_at"] = now_ms()
                    break
            else:
                return False
        self.save(state)
        return True

    def active(self, platform: str) -> int | None:
        value = self.load()["active"].get(platform)
        return value.get("accountId") if isinstance(value, dict) else None

    def set_active(self, platform: str, account_id: int) -> None:
        state = self.load()
        state["active"][platform] = {"accountId": account_id, "switchedAt": now_ms()}
        self.save(state)

    def groups(self) -> list[str]:
        return list(self.load()["groups"])

    def add_group(self, name: str) -> None:
        state = self.load()
        if name not in state["groups"]:
            state["groups"].append(name)
            self.save(state)

    def select(self, platform: str, strategy: str = "round-robin", groups: Iterable[str] = ()) -> Account | None:
        wanted = set(groups)
        candidates = [
            a
            for a in self.list()
            if a.platform == platform
            and a.status == "active"
            and (not wanted or wanted.intersection(a.groups))
        ]
        if not candidates:
            return None
        if strategy == "least-points":
            return min(candidates, key=lambda a: a.points)
        if strategy == "undated-first":
            return min(candidates, key=lambda a: a.last_checkin_date or "0000-00-00")
        current = self.active(platform)
        ids = [a.id for a in candidates]
        if current not in ids:
            return candidates[0]
        return candidates[(ids.index(current) + 1) % len(ids)]
