from __future__ import annotations

import base64
import getpass
import hashlib
import json
import os
import platform
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

from .util import ensure_dir, now_ms

_SALT = b"aiops-hub-vault-v1"
_MACHINE_SALT = b"aiops-hub-machine-v1"


class Vault:
    """AES-256-GCM credential vault; master key derived from the master password via scrypt."""

    def __init__(self, home: Path, password_env: str = "AIOPS_PASSWORD", password_file_env: str = "AIOPS_PASSWORD_FILE"):
        self.home = home
        self.path = home / "vault.json"
        self.master_path = home / "master.key"
        self.password_env = password_env
        self.password_file_env = password_file_env
        self._key: bytes | None = None

    @property
    def initialized(self) -> bool:
        return self.path.exists() and self.master_path.exists()

    def initialize(self, password: str) -> None:
        if len(password) < 6:
            raise ValueError("master password must be at least 6 characters")
        ensure_dir(self.home)
        machine_key = self._machine_key()
        aes = AESGCM(machine_key)
        nonce = os.urandom(12)
        sealed = nonce + aes.encrypt(nonce, password.encode("utf-8"), None)
        self.master_path.write_bytes(sealed)
        os.chmod(self.master_path, 0o600)
        self._write_encrypted({}, self._derive_key(password))
        self._key = None

    def resolve_password(self, explicit: str | None = None) -> str | None:
        if explicit:
            return explicit
        env_name = os.environ.get(self.password_env)
        if env_name:
            return env_name
        file_name = os.environ.get(self.password_file_env)
        if file_name and Path(file_name).exists():
            return Path(file_name).read_text(encoding="utf-8").strip()
        return self._load_master_password()

    def _load_master_password(self) -> str | None:
        if not self.master_path.exists():
            return None
        try:
            raw = self.master_path.read_bytes()
            aes = AESGCM(self._machine_key())
            return (aes.decrypt(raw[:12], raw[12:], None)).decode("utf-8")
        except Exception:
            return None

    def unlock(self, password: str | None = None) -> None:
        if not self.initialized:
            raise RuntimeError("vault not initialized; run 'init' first")
        secret = self.resolve_password(password)
        if not secret:
            raise RuntimeError("master password required (argument, env, file or master.key)")
        key = self._derive_key(secret)
        self._read_encrypted(key)  # validates password
        self._key = key

    def lock(self) -> None:
        self._key = None

    @property
    def unlocked(self) -> bool:
        return self._key is not None

    def put(self, credential_id: str, files: dict[str, bytes]) -> None:
        self._require_unlocked()
        data = self._read_encrypted(self._key)
        data[credential_id] = {
            "updated_at": now_ms(),
            "files": {name: base64.b64encode(content).decode("ascii") for name, content in files.items()},
        }
        self._write_encrypted(data, self._key)

    def get(self, credential_id: str) -> dict[str, bytes] | None:
        self._require_unlocked()
        data = self._read_encrypted(self._key)
        item = data.get(credential_id)
        if not item:
            return None
        return {name: base64.b64decode(value) for name, value in item["files"].items()}

    def delete(self, credential_id: str) -> None:
        self._require_unlocked()
        data = self._read_encrypted(self._key)
        data.pop(credential_id, None)
        self._write_encrypted(data, self._key)

    def ids(self) -> list[str]:
        self._require_unlocked()
        return sorted(self._read_encrypted(self._key).keys())

    # ---------- secure agent transport ----------
    @staticmethod
    def wrap_files(files: dict[str, bytes], agent_token: str) -> str:
        """Wrap arbitrary credential files for an agent using AES-GCM with its token."""
        payload = json.dumps({name: base64.b64encode(content).decode("ascii") for name, content in files.items()}).encode("utf-8")
        key = hashlib.sha256(agent_token.encode("utf-8")).digest()
        nonce = os.urandom(12)
        blob = nonce + AESGCM(key).encrypt(nonce, payload, None)
        return base64.b64encode(blob).decode("ascii")

    def export_for_agent(self, credential_id: str, agent_token: str) -> str:
        """Export one credential as an AES-GCM blob wrapped with the agent token."""
        self._require_unlocked()
        files = self.get(credential_id)
        if files is None:
            raise KeyError(f"credential not found: {credential_id}")
        return self.wrap_files(files, agent_token)

    @staticmethod
    def import_from_agent(blob_b64: str, agent_token: str) -> dict[str, bytes]:
        key = hashlib.sha256(agent_token.encode("utf-8")).digest()
        blob = base64.b64decode(blob_b64)
        payload = AESGCM(key).decrypt(blob[:12], blob[12:], None)
        encoded = json.loads(payload.decode("utf-8"))
        return {name: base64.b64decode(value) for name, value in encoded.items()}

    def _require_unlocked(self) -> None:
        if self._key is None:
            raise RuntimeError("vault is locked")

    @staticmethod
    def _derive_key(password: str) -> bytes:
        return Scrypt(salt=_SALT, length=32, n=2**14, r=8, p=1).derive(password.encode("utf-8"))

    @staticmethod
    def _machine_key() -> bytes:
        identity = f"{platform.node()}|{getpass.getuser()}|aiops-hub".encode("utf-8")
        return hashlib.scrypt(identity, salt=_MACHINE_SALT, n=2**14, r=8, p=1, dklen=32)

    def _write_encrypted(self, data: dict[str, Any], key: bytes) -> None:
        ensure_dir(self.home)
        nonce = os.urandom(12)
        plaintext = json.dumps(data, ensure_ascii=False).encode("utf-8")
        blob = nonce + AESGCM(key).encrypt(nonce, plaintext, None)
        self.path.write_bytes(blob)
        os.chmod(self.path, 0o600)

    def _read_encrypted(self, key: bytes) -> dict[str, Any]:
        raw = self.path.read_bytes()
        try:
            plain = AESGCM(key).decrypt(raw[:12], raw[12:], None)
        except Exception as exc:
            raise RuntimeError("invalid master password or corrupted vault") from exc
        return json.loads(plain.decode("utf-8"))
