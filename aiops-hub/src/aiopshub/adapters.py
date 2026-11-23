from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .config import HubConfig
from .storage import iter_files


class AdapterManager:
    """Unified platform adapter contract: capture / apply / check-in / points."""

    MAX_FILE_BYTES = 2 * 1024 * 1024

    def __init__(self, config: HubConfig):
        self.config = config
        self.adapters = config.adapters()

    def describe(self) -> list[dict[str, Any]]:
        result = []
        for platform, cfg in self.adapters.items():
            result.append(
                {
                    "platform": platform,
                    "label": cfg.get("label", platform),
                    "credential_dir": str(HubConfig(self.config.home).adapter_dir(platform)),
                    "checkin_mode": "auto" if cfg.get("checkin_url") else "manual",
                    "points_enabled": bool(cfg.get("points_url")),
                }
            )
        return result

    def capture(self, platform: str) -> dict[str, bytes]:
        root = self.config.adapter_dir(platform)
        files: dict[str, bytes] = {}
        for path in iter_files(root):
            if path.stat().st_size > self.MAX_FILE_BYTES:
                continue
            relative = path.relative_to(root).as_posix()
            files[relative] = path.read_bytes()
        return files

    def apply(self, platform: str, files: dict[str, bytes], target_dir: Path | None = None) -> Path:
        root = target_dir or self.config.adapter_dir(platform)
        root.mkdir(parents=True, exist_ok=True)
        for relative, content in files.items():
            safe = Path(relative)
            if safe.is_absolute() or ".." in safe.parts:
                continue
            destination = root / safe
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
        return root

    def extract_token(self, platform: str, files: dict[str, bytes]) -> str | None:
        cfg = self.adapters.get(platform, {})
        target = cfg.get("token_file")
        if not target or target not in files:
            return None
        try:
            data = json.loads(files[target].decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None
        path = cfg.get("token_json_path") or "token"
        node: Any = data
        for key in str(path).split("."):
            if not isinstance(node, dict):
                return None
            node = node.get(key)
        return str(node) if node else None

    def extract_device_id(self, platform: str, files: dict[str, bytes]) -> str | None:
        cfg = self.adapters.get(platform, {})
        target = cfg.get("token_file")
        path = cfg.get("device_id_json_path")
        if not target or not path or target not in files:
            return None
        try:
            data = json.loads(files[target].decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None
        node: Any = data
        for key in str(path).split("."):
            if not isinstance(node, dict):
                return None
            node = node.get(key)
        return str(node) if node else None

    def checkin(self, platform: str, account_id: int, account_name: str, files: dict[str, bytes]) -> dict[str, Any]:
        cfg = self.adapters.get(platform, {})
        url = cfg.get("checkin_url")
        if not url:
            return {"status": "skipped", "message": "no checkin_url configured; manual mode", "reward": 0, "balance": None}
        payload = {
            "account_id": account_id,
            "account_name": account_name,
            "platform": platform,
            "device_id": self.extract_device_id(platform, files),
            "timestamp": int(time.time()),
        }
        response = self._request(str(cfg.get("checkin_method", "POST")).upper(), str(url), payload, files, cfg)
        reward = int(response.get("reward", 0) or 0)
        balance = response.get("balance")
        return {
            "status": response.get("status", "success"),
            "message": response.get("message"),
            "reward": reward,
            "balance": int(balance) if balance is not None else None,
        }

    def points(self, platform: str, account_id: int, files: dict[str, bytes]) -> dict[str, Any]:
        cfg = self.adapters.get(platform, {})
        url = cfg.get("points_url")
        if not url:
            return {"balance": None, "quota": None, "status": "skipped"}
        response = self._request("POST", str(url), {"account_id": account_id, "platform": platform}, files, cfg)
        return {
            "status": response.get("status", "success"),
            "balance": int(response.get("balance", 0) or 0),
            "quota": int(response.get("quota", 0) or 0),
        }

    @staticmethod
    def _request(
        method: str,
        url: str,
        payload: dict[str, Any],
        files: dict[str, bytes],
        cfg: dict[str, Any],
    ) -> dict[str, Any]:
        headers = {"Content-Type": "application/json"}
        auth = cfg.get("auth")
        if isinstance(auth, dict):
            header_name = auth.get("header", "Authorization")
            token_template = auth.get("value", "Bearer {token}")
            token = AdapterManager._find_token(files)
            headers[header_name] = token_template.format(token=token or "")
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(url, data=body if method in ("POST", "PUT") else None, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            return {"status": "error", "message": f"HTTP {exc.code}: {detail}"}
        except Exception as exc:
            return {"status": "error", "message": str(exc)}

    @staticmethod
    def _find_token(files: dict[str, bytes]) -> str | None:
        for name, content in files.items():
            if not name.endswith(".json"):
                continue
            try:
                data = json.loads(content.decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            for key in ("token", "access_token", "refresh_token"):
                if isinstance(data, dict) and data.get(key):
                    return str(data[key])
        return None
