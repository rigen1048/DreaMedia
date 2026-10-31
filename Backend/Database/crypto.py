"""Per-user encryption (D7/D8/D9).

- Key derivation: Argon2id from (password, username-salt) — derived at
  login, held only in the in-memory vault, never on disk.
- Cipher: XChaCha20-Poly1305 (PyNaCl/libsodium) — AEAD, 192-bit nonce,
  no nonce-reuse concerns.
- Postgres stores only ciphertext; a sibling browsing the DB sees
  garbage without the user's password.
"""
from __future__ import annotations

import base64
import os

from argon2.low_level import Type, hash_secret_raw
from nacl import secret, utils

KEY_SIZE = secret.SecretBox.KEY_SIZE          # 32
NONCE_SIZE = secret.SecretBox.NONCE_SIZE      # 24 (XChaCha20)

_ARGON2_TIME = 3
_ARGON2_MEMORY = 65536   # 64 MiB
_ARGON2_PARALLELISM = 4


def derive_key(password: str, username: str) -> bytes:
    """Password + username (as salt) → 32-byte encryption key.

    Username as salt means identical passwords for different users yield
    different keys — and the salt is not secret anyway.
    """
    return hash_secret_raw(
        secret=password.encode(),
        salt=(username.lower().ljust(16, "\0"))[:16].encode(),
        time_cost=_ARGON2_TIME,
        memory_cost=_ARGON2_MEMORY,
        parallelism=_ARGON2_PARALLELISM,
        hash_len=KEY_SIZE,
        type=Type.ID,
    )


def index_hash(key: bytes, plaintext: str) -> bytes:
    """Blind index: HMAC-SHA256(key, plaintext).

    Random nonces make ciphertext non-deterministic, so UNIQUE(index_enc)
    could never dedupe. The blind index is deterministic — equality
    checks and uniqueness work — while leaking nothing about the content.
    """
    import hashlib
    import hmac

    return hmac.new(key, plaintext.encode(), hashlib.sha256).digest()


def encrypt(key: bytes, plaintext: str | None) -> bytes | None:
    if plaintext is None:
        return None
    nonce = utils.random(NONCE_SIZE)
    box = secret.SecretBox(key)
    # SecretBox.encrypt prepends the nonce automatically.
    return box.encrypt(plaintext.encode(), nonce)


def decrypt(key: bytes, ciphertext: bytes | memoryview | None) -> str | None:
    if ciphertext is None:
        return None
    box = secret.SecretBox(key)
    return box.decrypt(bytes(ciphertext)).decode()


def b64e(key: bytes, plaintext: str | None) -> str | None:
    """Encrypt → base64 str (for JSON transport inside payloads)."""
    raw = encrypt(key, plaintext)
    return base64.b64encode(raw).decode() if raw is not None else None


def b64d(key: bytes, payload: str | None) -> str | None:
    if payload is None:
        return None
    return decrypt(key, base64.b64decode(payload))
