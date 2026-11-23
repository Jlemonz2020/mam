from __future__ import annotations

import contextlib
import copy
import json
import os
from pathlib import Path
from typing import Any, Iterator

from .util import checksum, ensure_dir, fsync_path, now_ms


class StateStore:
    """Atomic, checksummed JSON state with .bak fallback and corruption quarantine."""

    def __init__(self, path: Path, default: dict[str, Any] | None = None, keep_backup: bool = True):
        self.path = path
        self.default = copy.deepcopy(default) if default else {"version": 1}
        self.keep_backup = keep_backup

    def load(self) -> dict[str, Any]:
        for candidate in (self.path, self.path.with_name(self.path.name + ".bak")):
            try:
                wrapper = json.loads(candidate.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            data = wrapper.get("data")
            if not isinstance(data, dict) or wrapper.get("checksum") != checksum(data):
                self._quarantine(candidate)
                continue
            return data
        # No usable state: seed from a private default copy and persist it.
        seeded = copy.deepcopy(self.default)
        self.save(seeded)
        return copy.deepcopy(seeded)

    def save(self, data: dict[str, Any]) -> None:
        ensure_dir(self.path.parent)
        wrapper = {"version": 1, "checksum": checksum(data), "data": data}
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(json.dumps(wrapper, ensure_ascii=False, indent=2), encoding="utf-8")
        fsync_path(tmp)
        if self.path.exists() and self.keep_backup:
            with contextlib.suppress(OSError):
                self.path.replace(self.path.with_name(self.path.name + ".bak"))
        os.replace(tmp, self.path)

    def _quarantine(self, source: Path) -> None:
        with contextlib.suppress(OSError):
            target = source.with_name(source.name + f".corrupt-{now_ms()}")
            source.replace(target)


class RecordsStore:
    """Append-only NDJSON event log with automatic rotation."""

    def __init__(self, path: Path, max_lines: int = 20000):
        self.path = path
        self.max_lines = max_lines

    def append(self, event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        ensure_dir(self.path.parent)
        record = {"t": event_type, "ts": now_ms(), "r": payload}
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
            fh.flush()
        fsync_path(self.path)
        self._maybe_rotate()
        return record

    def read(self, limit: int = 500, event_type: str | None = None) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        result: list[dict[str, Any]] = []
        with self.path.open("r", encoding="utf-8") as fh:
            for line in fh:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event_type and record.get("t") != event_type:
                    continue
                result.append(record)
        return result[-limit:]

    def _maybe_rotate(self) -> None:
        if not self.path.exists():
            return
        with self.path.open("r", encoding="utf-8") as fh:
            count = sum(1 for _ in fh)
        if count <= self.max_lines:
            return
        records = self.read(limit=count)
        backup = self.path.with_name(self.path.name + ".bak")
        with contextlib.suppress(OSError):
            self.path.replace(backup)
        keep: list[str] = []
        with self.path.open("w", encoding="utf-8") as fh:
            for record in records:
                if record.get("t") == "snapshot" and sum(r.startswith("snapshot") for r in keep) > 200:
                    continue
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")
                keep.append(record.get("t", ""))
            fh.flush()
        fsync_path(self.path)


def iter_files(root: Path) -> Iterator[Path]:
    if not root.exists():
        return
    for path in root.rglob("*"):
        if path.is_file():
            yield path
