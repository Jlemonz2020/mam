from __future__ import annotations

import contextlib
import hashlib
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


def now_ms() -> int:
    return int(time.time() * 1000)


def iso(ms: int | None = None) -> str:
    value = ms if ms is not None else now_ms()
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc).isoformat()


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def canonical_json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def checksum(data: Any) -> str:
    return hashlib.sha256(canonical_json(data).encode("utf-8")).hexdigest()


def gen_id(prefix: str = "") -> str:
    return f"{prefix}{int(time.time() * 1000)}{os.getpid() % 1000:03d}"


def safe_name(name: str) -> str:
    keep = "-_."
    return "".join(c if c.isalnum() or c in keep else "_" for c in name)[:120]


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError, OSError):
        return False


class FileLock:
    """Cross-platform advisory lock file with stale detection."""

    def __init__(self, path: Path, ttl_seconds: int = 300):
        self.path = path
        self.ttl_ms = ttl_seconds * 1000
        self._acquired = False

    def acquire(self, timeout: float = 5.0) -> bool:
        ensure_dir(self.path.parent)
        deadline = time.time() + timeout
        while True:
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    fh.write(f"{os.getpid()}\n{now_ms()}\n")
                    fh.flush()
                    os.fsync(fh.fileno())
                self._acquired = True
                return True
            except FileExistsError:
                try:
                    parts = self.path.read_text(encoding="utf-8").split()
                    pid = int(parts[0])
                    stamp = int(parts[1])
                except (OSError, ValueError, IndexError):
                    stamp = 0
                    pid = -1
                stale = (now_ms() - stamp) > self.ttl_ms or not pid_alive(pid)
                if stale:
                    with contextlib.suppress(OSError):
                        self.path.unlink()
                    continue
                if time.time() >= deadline:
                    return False
                time.sleep(0.1)

    def release(self) -> None:
        if self._acquired:
            with contextlib.suppress(OSError):
                self.path.unlink()
            self._acquired = False

    def __enter__(self) -> "FileLock":
        if not self.acquire():
            raise RuntimeError(f"lock busy: {self.path.name}")
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.release()


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def fsync_path(path: Path) -> None:
    fd = os.open(path, os.O_RDWR)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_json(path: Path, data: Any) -> None:
    ensure_dir(path.parent)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    fsync_path(tmp)
    if path.exists():
        with contextlib.suppress(OSError):
            path.replace(path.with_name(path.name + ".bak"))
    os.replace(tmp, path)


def mask(value: str | None, keep: int = 4) -> str:
    if not value:
        return ""
    if len(value) <= keep * 2:
        return "*" * len(value)
    return value[:keep] + "…" + value[-keep:]
