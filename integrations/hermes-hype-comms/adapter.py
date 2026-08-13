"""Hermes platform adapter for Hype Comms.

The adapter deliberately delegates every product-network operation to
``hype-comms-cli``. Agent tokens remain in the child environment, message bodies
travel over stdin, and watch stdout is parsed as NDJSON only.
"""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import logging
import os
import random
import re
import shutil
import tempfile
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Mapping, Optional
from urllib.parse import urlsplit

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)

logger = logging.getLogger(__name__)

PLATFORM_NAME = "hype_comms"
DEFAULT_CLI = "hype-comms-cli"
DEFAULT_COMMAND_TIMEOUT_SECONDS = 60.0
MAX_CLI_OUTPUT_BYTES = 1_048_576
MAX_DIAGNOSTIC_BYTES = 65_536
MAX_MESSAGE_LENGTH = 4_000
CURSOR_FILE_VERSION = 1
REQUIRED_AGENT_SCOPES = frozenset({"workspace:read", "messages:write"})
CONVERSATION_SESSION_EXTRA = {
    "group_sessions_per_user": False,
    "thread_sessions_per_user": False,
}
SUPPORTED_EVENT_TYPES = frozenset(
    {
        "system.connected",
        "system.resync_required",
        "member.updated",
        "channel.created",
        "channel.archived",
        "direct_conversation.created",
        "channel.membership_changed",
        "message.created",
        "read_cursor.updated",
    }
)
_TRUE_VALUES = frozenset({"1", "true", "yes", "on"})
_DECIMAL_CURSOR = re.compile(r"^(?:0|[1-9][0-9]*)$")
_TOKEN_PATTERN = re.compile(r"\bhype_comms_agent_[A-Za-z0-9_-]+\b")
_BEARER_PATTERN = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]+\b")
_URL_USERINFO_PATTERN = re.compile(r"([a-zA-Z][a-zA-Z0-9+.-]*://)[^/\s@]+@")
_POSIX_PATH_PATTERN = re.compile(r"(?<![:/A-Za-z0-9_])/(?!/)[^\s\"'<>]*")
_WINDOWS_PATH_PATTERN = re.compile(r"(?i)\b[A-Z]:\\[^\s\"'<>]*")
_TRACEBACK_PATTERN = re.compile(
    r"(?i)^(?:Traceback \(most recent call last\):|File \".*\", line \d+|"
    r"During handling of the above exception|[A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception):)"
)

ProcessFactory = Callable[..., Awaitable[Any]]


@dataclass(frozen=True)
class CliFailure(Exception):
    """Safe, classified failure from one CLI subprocess."""

    exit_code: int
    code: str
    message: str
    retryable: bool
    http_status: Optional[int] = None
    request_id: Optional[str] = None
    retry_after: Optional[float] = None
    error_kind: str = "unknown"

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"

    def safe_metadata(self) -> Dict[str, Any]:
        metadata: Dict[str, Any] = {
            "code": self.code,
            "exitCode": self.exit_code,
            "retryable": self.retryable,
        }
        if self.http_status is not None:
            metadata["httpStatus"] = self.http_status
        if self.request_id:
            metadata["requestId"] = self.request_id
        return metadata


def _truthy(value: object) -> bool:
    return str(value or "").strip().lower() in _TRUE_VALUES


def _safe_text(value: object, *, fallback: str = "Hype Comms CLI failed") -> str:
    raw_text = str(value or "").replace("\x00", "")
    if raw_text.startswith((" ", "\t")):
        return fallback
    text = raw_text.strip()
    if not text:
        return fallback
    first_line = text.splitlines()[0]
    if _TRACEBACK_PATTERN.match(first_line):
        return fallback
    first_line = _TOKEN_PATTERN.sub("[REDACTED_TOKEN]", first_line)
    first_line = _BEARER_PATTERN.sub("Bearer [REDACTED_TOKEN]", first_line)
    first_line = _URL_USERINFO_PATTERN.sub(r"\1[REDACTED]@", first_line)
    first_line = _POSIX_PATH_PATTERN.sub("[REDACTED_PATH]", first_line)
    first_line = _WINDOWS_PATH_PATTERN.sub("[REDACTED_PATH]", first_line)
    return first_line[:500]


def _decode_output(value: object, *, limit: int = MAX_CLI_OUTPUT_BYTES) -> str:
    if isinstance(value, bytes):
        if len(value) > limit:
            raise CliFailure(
                6,
                "CLI_OUTPUT_TOO_LARGE",
                "Hype Comms CLI output exceeded the adapter limit",
                False,
            )
        try:
            return value.decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise CliFailure(
                6,
                "INVALID_CLI_ENCODING",
                "Hype Comms CLI output was not valid UTF-8",
                False,
            ) from exc
    text = str(value or "")
    if len(text.encode("utf-8")) > limit:
        raise CliFailure(
            6,
            "CLI_OUTPUT_TOO_LARGE",
            "Hype Comms CLI output exceeded the adapter limit",
            False,
        )
    return text


def _error_kind(exit_code: int, code: str, http_status: Optional[int]) -> str:
    normalized = code.upper()
    if http_status == 429 or "RATE" in normalized:
        return "rate_limited"
    if http_status in {401, 403} or normalized in {
        "AUTHENTICATION_REQUIRED",
        "FORBIDDEN",
        "TOKEN_REVOKED",
    }:
        return "forbidden"
    if exit_code == 3:
        return "forbidden"
    if http_status == 404 or "NOT_FOUND" in normalized:
        return "not_found"
    if http_status == 413 or normalized in {"MESSAGE_TOO_LONG", "PAYLOAD_TOO_LARGE"}:
        return "too_long"
    if exit_code == 5 or http_status == 408 or (http_status is not None and http_status >= 500):
        return "transient"
    if exit_code in {2, 4, 6}:
        return "bad_format"
    return "unknown"


def _structured_error(stderr: str) -> Optional[Mapping[str, Any]]:
    for line in reversed(stderr.splitlines()):
        try:
            value = json.loads(line)
        except (TypeError, ValueError):
            continue
        if not isinstance(value, dict):
            continue
        error = value.get("error")
        if isinstance(error, dict):
            return error
    return None


def _failure_from_exit(exit_code: int, stderr: str) -> CliFailure:
    error = _structured_error(stderr) or {}
    raw_status = error.get("httpStatus")
    http_status = raw_status if isinstance(raw_status, int) else None
    code = _safe_text(error.get("code"), fallback=f"CLI_EXIT_{exit_code}")
    message = _safe_text(error.get("message"))
    retry_after_ms = error.get("retryAfterMs")
    retry_after = (
        max(0.0, float(retry_after_ms) / 1_000.0)
        if isinstance(retry_after_ms, (int, float)) and not isinstance(retry_after_ms, bool)
        else None
    )
    retryable = (
        exit_code == 5
        or http_status == 408
        or http_status == 429
        or (http_status is not None and http_status >= 500)
    )
    request_id = error.get("requestId")
    return CliFailure(
        exit_code=exit_code,
        code=code,
        message=message,
        retryable=retryable,
        http_status=http_status,
        request_id=_safe_text(request_id, fallback="") or None,
        retry_after=retry_after,
        error_kind=_error_kind(exit_code, code, http_status),
    )


def _watch_failure_from_exit(exit_code: int, stderr: str) -> CliFailure:
    if exit_code in {2, 3, 4, 5, 6}:
        return _failure_from_exit(exit_code, stderr)
    return CliFailure(
        5,
        "WATCH_PROCESS_EXITED",
        "Hype Comms watch process exited unexpectedly",
        True,
        error_kind="transient",
    )


def _log_diagnostics(stderr: str) -> None:
    for line in stderr.splitlines():
        safe = _safe_text(line, fallback="")
        if safe:
            logger.info("[Hype Comms CLI] %s", safe)


def _canonical_origin(raw_origin: str) -> str:
    try:
        parsed = urlsplit(raw_origin.strip())
        port = parsed.port
    except (TypeError, ValueError) as exc:
        raise ValueError("HYPE_COMMS_API_ORIGIN is invalid") from exc
    if parsed.scheme not in {"https", "http"} or not parsed.hostname:
        raise ValueError("HYPE_COMMS_API_ORIGIN must be an HTTP(S) origin")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("HYPE_COMMS_API_ORIGIN must not contain credentials")
    if parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise ValueError("HYPE_COMMS_API_ORIGIN must not contain a path, query, or fragment")
    host = parsed.hostname.lower().rstrip(".")
    if parsed.scheme == "http":
        try:
            loopback = ipaddress.ip_address(host).is_loopback
        except ValueError:
            loopback = host == "localhost"
        if not loopback:
            raise ValueError("Plaintext Hype Comms origins must be loopback")
    bracketed_host = f"[{host}]" if ":" in host else host
    netloc = bracketed_host if port is None else f"{bracketed_host}:{port}"
    return f"{parsed.scheme}://{netloc}"


def _cli_path(config: Optional[PlatformConfig] = None) -> str:
    extra = getattr(config, "extra", {}) or {}
    return str(os.getenv("HYPE_COMMS_CLI_PATH") or extra.get("cli_path") or DEFAULT_CLI).strip()


def _configured_origin(config: Optional[PlatformConfig] = None) -> str:
    extra = getattr(config, "extra", {}) or {}
    value = str(os.getenv("HYPE_COMMS_API_ORIGIN") or extra.get("api_origin") or "").strip()
    if not value:
        raise ValueError("HYPE_COMMS_API_ORIGIN is required")
    return _canonical_origin(value)


def _configured_token() -> str:
    token = os.getenv("HYPE_COMMS_TOKEN", "")
    if not token:
        raise ValueError("HYPE_COMMS_TOKEN is required")
    return token


def _has_access_policy() -> bool:
    return bool(os.getenv("HYPE_COMMS_ALLOWED_USERS", "").strip()) or _truthy(
        os.getenv("HYPE_COMMS_ALLOW_ALL_USERS")
    )


def _child_environment(origin: str, token: str) -> Dict[str, str]:
    child_env = dict(os.environ)
    child_env["HYPE_COMMS_API_ORIGIN"] = origin
    child_env["HYPE_COMMS_TOKEN"] = token
    return child_env


async def _run_cli_json(
    cli: str,
    args: List[str],
    *,
    origin: str,
    token: str,
    stdin_text: Optional[str] = None,
    timeout: float = DEFAULT_COMMAND_TIMEOUT_SECONDS,
    process_factory: ProcessFactory = asyncio.create_subprocess_exec,
) -> Dict[str, Any]:
    try:
        process = await process_factory(
            cli,
            *args,
            stdin=asyncio.subprocess.PIPE if stdin_text is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=_child_environment(origin, token),
        )
    except FileNotFoundError as exc:
        raise CliFailure(2, "CLI_NOT_FOUND", "hype-comms-cli is not installed", False) from exc
    except OSError as exc:
        raise CliFailure(2, "CLI_START_FAILED", "hype-comms-cli could not be started", False) from exc

    try:
        stdout_raw, stderr_raw = await asyncio.wait_for(
            process.communicate(
                input=stdin_text.encode("utf-8") if stdin_text is not None else None
            ),
            timeout=timeout,
        )
    except asyncio.TimeoutError as exc:
        try:
            process.kill()
        except ProcessLookupError:
            pass
        try:
            await process.wait()
        except Exception:
            pass
        raise CliFailure(
            5,
            "CLI_TIMEOUT",
            "Hype Comms CLI request timed out",
            True,
            error_kind="transient",
        ) from exc

    stdout = _decode_output(stdout_raw)
    stderr = _decode_output(stderr_raw, limit=MAX_DIAGNOSTIC_BYTES)
    if process.returncode != 0:
        raise _failure_from_exit(int(process.returncode or 1), stderr)
    _log_diagnostics(stderr)
    try:
        result = json.loads(stdout)
    except (TypeError, ValueError) as exc:
        raise CliFailure(
            6,
            "INVALID_CLI_JSON",
            "Hype Comms CLI returned invalid JSON",
            False,
            error_kind="bad_format",
        ) from exc
    if not isinstance(result, dict):
        raise CliFailure(
            6,
            "INVALID_CLI_CONTRACT",
            "Hype Comms CLI returned an unexpected JSON result",
            False,
            error_kind="bad_format",
        )
    return result


def _message_id(result: Mapping[str, Any]) -> str:
    message = result.get("message")
    if not isinstance(message, dict) or not isinstance(message.get("id"), str):
        raise CliFailure(
            6,
            "INVALID_SEND_CONTRACT",
            "Hype Comms CLI send result had no canonical message ID",
            False,
            error_kind="bad_format",
        )
    return str(message["id"])


async def _standalone_send(
    pconfig: PlatformConfig,
    chat_id: str,
    message: str,
    *,
    thread_id: Optional[str] = None,
    media_files: Optional[List[str]] = None,
    force_document: bool = False,
) -> Dict[str, Any]:
    """Send from an out-of-process Hermes cron invocation."""

    del thread_id, force_document
    if media_files:
        return {"error": "Hype Comms adapter does not support media delivery"}
    try:
        origin = _configured_origin(pconfig)
        token = _configured_token()
        result = await _run_cli_json(
            _cli_path(pconfig),
            ["messages", "send", str(chat_id), "--json"],
            origin=origin,
            token=token,
            stdin_text=message,
        )
        return {"success": True, "message_id": _message_id(result)}
    except (CliFailure, ValueError) as exc:
        return {"error": _safe_text(exc)}


class HypeCommsAdapter(BasePlatformAdapter):
    """Persistent Hype Comms participant backed by ``hype-comms-cli``."""

    supports_code_blocks = True

    @property
    def message_len_fn(self) -> Callable[[str], int]:
        # Hype Comms's Zod contract runs in JavaScript, where string length is
        # measured in UTF-16 code units.
        return lambda value: len(value.encode("utf-16-le")) // 2

    def __init__(
        self,
        config: PlatformConfig,
        *,
        process_factory: ProcessFactory = asyncio.create_subprocess_exec,
        state_dir: Optional[Path] = None,
    ):
        existing_extra = getattr(config, "extra", None)
        if existing_extra is None:
            extra: Dict[str, Any] = {}
        elif isinstance(existing_extra, Mapping):
            # PlatformConfig instances normally own a dict. Copy it so an
            # adapter cannot mutate a caller-owned mapping while making the
            # conversation-scoped session policy authoritative for Hype Comms.
            extra = dict(existing_extra)
        else:
            raise ValueError("Hype Comms PlatformConfig.extra must be a mapping")
        extra.update(CONVERSATION_SESSION_EXTRA)
        config.extra = extra
        super().__init__(config, Platform(PLATFORM_NAME))
        self._process_factory = process_factory
        self._state_dir_override = state_dir
        self._api_origin = ""
        self._agent_user_id = ""
        self._workspace_id = ""
        self._agent_user: Dict[str, Any] = {}
        self._members: Dict[str, Dict[str, Any]] = {}
        self._conversations: Dict[str, Dict[str, Any]] = {}
        self._cursor: Optional[str] = None
        self._cursor_path: Optional[Path] = None
        self._watch_process: Any = None
        self._watch_task: Optional[asyncio.Task[Any]] = None
        self._stop_event = asyncio.Event()
        self._lock_held = False
        self._backoff_base = 0.5
        self._backoff_max = 30.0

    def _require_compatible_gateway_session_config(self) -> None:
        """Fail closed when Hermes would still append an author to a channel key."""

        session_configs: List[Any] = []
        runner_config = getattr(getattr(self, "gateway_runner", None), "config", None)
        if runner_config is not None:
            session_configs.append(runner_config)
        store_config = getattr(getattr(self, "_session_store", None), "config", None)
        if store_config is not None and store_config is not runner_config:
            session_configs.append(store_config)

        for session_config in session_configs:
            group_per_user = bool(
                getattr(session_config, "group_sessions_per_user", True)
            )
            thread_per_user = bool(
                getattr(session_config, "thread_sessions_per_user", False)
            )
            if group_per_user and thread_per_user:
                raise CliFailure(
                    2,
                    "INCOMPATIBLE_HERMES_SESSION_CONFIG",
                    (
                        "Hype Comms requires shared Hermes thread sessions; "
                        "disable gateway.thread_sessions_per_user"
                    ),
                    False,
                    error_kind="bad_format",
                )

    async def _command(
        self,
        args: List[str],
        *,
        stdin_text: Optional[str] = None,
    ) -> Dict[str, Any]:
        try:
            token = _configured_token()
        except ValueError as exc:
            raise CliFailure(
                2,
                "CONFIG_INVALID",
                "HYPE_COMMS_TOKEN is required",
                False,
                error_kind="forbidden",
            ) from exc
        return await _run_cli_json(
            _cli_path(self.config),
            args,
            origin=self._api_origin,
            token=token,
            stdin_text=stdin_text,
            process_factory=self._process_factory,
        )

    @staticmethod
    def _agent_identity(principal: Mapping[str, Any]) -> tuple[Dict[str, Any], str]:
        user = principal.get("user")
        workspace_id = principal.get("workspaceId")
        scopes = principal.get("scopes")
        if (
            principal.get("type") != "agent"
            or not isinstance(user, dict)
            or not isinstance(user.get("id"), str)
            or not isinstance(workspace_id, str)
            or not isinstance(scopes, list)
            or not all(isinstance(scope, str) for scope in scopes)
        ):
            raise CliFailure(
                6,
                "AGENT_PRINCIPAL_REQUIRED",
                "Hype Comms token did not resolve to an agent principal",
                False,
                error_kind="forbidden",
            )
        missing = REQUIRED_AGENT_SCOPES.difference(scopes)
        if missing:
            raise CliFailure(
                3,
                "AGENT_SCOPE_MISSING",
                "Hype Comms agent token lacks required adapter scopes",
                False,
                error_kind="forbidden",
            )
        return dict(user), workspace_id

    @staticmethod
    def _checked_cursor(value: object) -> str:
        if not isinstance(value, str) or not _DECIMAL_CURSOR.fullmatch(value):
            raise CliFailure(
                6,
                "INVALID_CURSOR",
                "Hype Comms CLI returned an invalid workspace cursor",
                False,
                error_kind="bad_format",
            )
        return value

    async def _load_directory(self) -> str:
        # workspaceBootstrapResponseSchema already includes a `members` array
        # with the same member shape as `workspace members`, so fetch it
        # once from bootstrap instead of a separate CLI call. The two
        # remaining calls are independent and can run concurrently.
        bootstrap, conversation_result = await asyncio.gather(
            self._command(["workspace", "bootstrap", "--json"]),
            self._command(["conversations", "list", "--all", "--json"]),
        )

        workspace = bootstrap.get("workspace")
        current_user = bootstrap.get("currentUser")
        members = bootstrap.get("members")
        conversations = conversation_result.get("conversations")
        if (
            not isinstance(workspace, dict)
            or workspace.get("id") != self._workspace_id
            or not isinstance(current_user, dict)
            or current_user.get("type") != "agent"
            or current_user.get("workspaceId") != self._workspace_id
            or not isinstance(current_user.get("user"), dict)
            or current_user["user"].get("id") != self._agent_user_id
            or not isinstance(members, list)
            or not isinstance(conversations, list)
        ):
            raise CliFailure(
                6,
                "INVALID_DIRECTORY_CONTRACT",
                "Hype Comms CLI returned inconsistent workspace metadata",
                False,
                error_kind="bad_format",
            )

        next_members: Dict[str, Dict[str, Any]] = {}
        for member in members:
            if not isinstance(member, dict) or not isinstance(member.get("id"), str):
                raise CliFailure(
                    6,
                    "INVALID_MEMBER_CONTRACT",
                    "Hype Comms CLI returned invalid member metadata",
                    False,
                    error_kind="bad_format",
                )
            next_members[str(member["id"])] = dict(member)
        next_members[self._agent_user_id] = dict(self._agent_user)

        next_conversations: Dict[str, Dict[str, Any]] = {}
        for summary in conversations:
            if not isinstance(summary, dict):
                raise CliFailure(
                    6,
                    "INVALID_CONVERSATION_CONTRACT",
                    "Hype Comms CLI returned invalid conversation metadata",
                    False,
                    error_kind="bad_format",
                )
            conversation = summary.get("conversation")
            participant_ids = summary.get("participantIds")
            if (
                not isinstance(conversation, dict)
                or not isinstance(conversation.get("id"), str)
                or not isinstance(participant_ids, list)
                or not all(isinstance(item, str) for item in participant_ids)
            ):
                raise CliFailure(
                    6,
                    "INVALID_CONVERSATION_CONTRACT",
                    "Hype Comms CLI returned invalid conversation metadata",
                    False,
                    error_kind="bad_format",
                )
            next_conversations[str(conversation["id"])] = {
                "conversation": dict(conversation),
                "participantIds": list(participant_ids),
            }

        self._members = next_members
        self._conversations = next_conversations
        return self._checked_cursor(bootstrap.get("syncCursor"))

    def _state_root(self) -> Path:
        if self._state_dir_override is not None:
            return self._state_dir_override
        configured = os.getenv("HYPE_COMMS_HERMES_STATE_DIR", "").strip()
        if configured:
            return Path(configured).expanduser()
        hermes_home = Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))
        return hermes_home / "state" / "hype-comms"

    def _select_cursor_path(self) -> Path:
        identity_key = hashlib.sha256(
            f"{self._api_origin}\0{self._agent_user_id}".encode("utf-8")
        ).hexdigest()[:32]
        try:
            state_dir = self._state_root() / identity_key
            state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.chmod(state_dir, 0o700)
        except OSError as exc:
            raise CliFailure(
                6,
                "CURSOR_STATE_UNAVAILABLE",
                "Hype Comms cursor state directory is unavailable",
                False,
                error_kind="bad_format",
            ) from exc
        return state_dir / "cursor.json"

    def _load_cursor(self) -> Optional[str]:
        if self._cursor_path is None or not self._cursor_path.exists():
            return None
        try:
            payload = json.loads(self._cursor_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise CliFailure(
                6,
                "CURSOR_STATE_INVALID",
                "Hype Comms cursor checkpoint is unreadable",
                False,
                error_kind="bad_format",
            ) from exc
        if not isinstance(payload, dict) or payload.get("version") != CURSOR_FILE_VERSION:
            raise CliFailure(
                6,
                "CURSOR_STATE_INVALID",
                "Hype Comms cursor checkpoint has an unsupported format",
                False,
                error_kind="bad_format",
            )
        return self._checked_cursor(payload.get("cursor"))

    def _persist_cursor(self, cursor: str) -> None:
        cursor = self._checked_cursor(cursor)
        if self._cursor_path is None:
            raise CliFailure(
                6,
                "CURSOR_STATE_UNAVAILABLE",
                "Hype Comms cursor checkpoint is unavailable",
                False,
                error_kind="bad_format",
            )
        encoded = (
            json.dumps(
                {"version": CURSOR_FILE_VERSION, "cursor": cursor},
                separators=(",", ":"),
            )
            + "\n"
        ).encode("utf-8")
        try:
            fd, temporary_name = tempfile.mkstemp(
                prefix=".cursor-",
                suffix=".tmp",
                dir=str(self._cursor_path.parent),
            )
            try:
                os.fchmod(fd, 0o600)
                with os.fdopen(fd, "wb", closefd=True) as handle:
                    fd = -1
                    handle.write(encoded)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary_name, self._cursor_path)
                os.chmod(self._cursor_path, 0o600)
                try:
                    directory_fd = os.open(self._cursor_path.parent, os.O_RDONLY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                except OSError:
                    pass
            finally:
                if fd >= 0:
                    os.close(fd)
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass
        except OSError as exc:
            raise CliFailure(
                6,
                "CURSOR_STATE_WRITE_FAILED",
                "Hype Comms cursor checkpoint could not be saved",
                False,
                error_kind="bad_format",
            ) from exc
        self._cursor = cursor

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        del is_reconnect
        if self._watch_task is not None and not self._watch_task.done():
            return True
        self._stop_event.clear()
        try:
            if not _has_access_policy():
                raise CliFailure(
                    2,
                    "ACCESS_POLICY_REQUIRED",
                    "Configure HYPE_COMMS_ALLOWED_USERS or explicitly allow all users",
                    False,
                    error_kind="forbidden",
                )
            self._api_origin = _configured_origin(self.config)
            _configured_token()
            self._require_compatible_gateway_session_config()

            principal = await self._command(["auth", "whoami", "--json"])
            self._agent_user, self._workspace_id = self._agent_identity(principal)
            self._agent_user_id = str(self._agent_user["id"])
            bootstrap_cursor = await self._load_directory()

            lock_identity = f"{self._api_origin}\0{self._agent_user_id}"
            if not self._acquire_platform_lock(
                "hype-comms-agent",
                lock_identity,
                "Hype Comms agent identity",
            ):
                return False
            self._lock_held = True

            self._cursor_path = self._select_cursor_path()
            self._cursor = self._load_cursor()
            if self._cursor is None:
                # First install starts at the bootstrap high-water cursor. It
                # must never wake Hermes for pre-installation history.
                self._persist_cursor(bootstrap_cursor)

            process = await self._spawn_watch()
            self._watch_process = process
            self._mark_connected()
            self._watch_task = asyncio.create_task(
                self._watch_supervisor(process),
                name="hype-comms-watch-supervisor",
            )
            logger.info("Hype Comms adapter connected")
            return True
        except (CliFailure, ValueError) as exc:
            failure = (
                exc
                if isinstance(exc, CliFailure)
                else CliFailure(2, "CONFIG_INVALID", _safe_text(exc), False)
            )
            logger.error("Hype Comms adapter startup failed: %s", failure)
            self._set_fatal_error(failure.code, failure.message, retryable=failure.retryable)
            if self._lock_held:
                self._release_platform_lock()
                self._lock_held = False
            self._mark_disconnected()
            return False

    async def _spawn_watch(self) -> Any:
        if self._cursor is None:
            raise CliFailure(
                6,
                "CURSOR_STATE_UNAVAILABLE",
                "Hype Comms cursor checkpoint is unavailable",
                False,
            )
        try:
            token = _configured_token()
        except ValueError as exc:
            raise CliFailure(
                2,
                "CONFIG_INVALID",
                "HYPE_COMMS_TOKEN is required",
                False,
                error_kind="forbidden",
            ) from exc
        try:
            return await self._process_factory(
                _cli_path(self.config),
                "watch",
                "--json",
                "--after",
                self._cursor,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=_child_environment(self._api_origin, token),
                limit=MAX_CLI_OUTPUT_BYTES + 1,
            )
        except FileNotFoundError as exc:
            raise CliFailure(2, "CLI_NOT_FOUND", "hype-comms-cli is not installed", False) from exc
        except OSError as exc:
            raise CliFailure(
                5,
                "WATCH_START_FAILED",
                "Hype Comms watch process could not be started",
                True,
                error_kind="transient",
            ) from exc

    async def _read_watch_stderr(self, process: Any) -> str:
        captured = bytearray()
        if process.stderr is None:
            return ""
        while True:
            raw = await process.stderr.readline()
            if not raw:
                break
            try:
                text = _decode_output(raw, limit=MAX_DIAGNOSTIC_BYTES)
            except CliFailure:
                text = ""
            _log_diagnostics(text)
            if len(captured) < MAX_DIAGNOSTIC_BYTES:
                captured.extend(raw[: MAX_DIAGNOSTIC_BYTES - len(captured)])
        return _decode_output(bytes(captured), limit=MAX_DIAGNOSTIC_BYTES)

    async def _consume_watch(self, process: Any) -> tuple[int, bool, bool, str]:
        if process.stdout is None:
            raise CliFailure(
                6,
                "WATCH_STDOUT_UNAVAILABLE",
                "Hype Comms watch stdout was unavailable",
                False,
            )
        stderr_task = asyncio.create_task(self._read_watch_stderr(process))
        saw_event = False
        needs_resync = False
        try:
            while not self._stop_event.is_set():
                raw_line = await process.stdout.readline()
                if not raw_line:
                    break
                if len(raw_line) > MAX_CLI_OUTPUT_BYTES:
                    raise CliFailure(
                        6,
                        "WATCH_LINE_TOO_LARGE",
                        "Hype Comms watch emitted an oversized record",
                        False,
                    )
                line = _decode_output(raw_line).strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except (TypeError, ValueError) as exc:
                    raise CliFailure(
                        6,
                        "INVALID_WATCH_JSON",
                        "Hype Comms watch emitted invalid NDJSON",
                        False,
                        error_kind="bad_format",
                    ) from exc
                if not isinstance(event, dict):
                    raise CliFailure(
                        6,
                        "INVALID_WATCH_CONTRACT",
                        "Hype Comms watch emitted an unexpected record",
                        False,
                        error_kind="bad_format",
                    )
                outcome = await self._accept_event(event)
                saw_event = True
                if outcome == "resync":
                    needs_resync = True
                    await self._terminate_process(process)
                    break
            return_code = await process.wait()
        except BaseException:
            # Parsing or contract failures must close the child before the
            # stderr reader is drained. Otherwise a still-running watch can
            # keep stderr open forever and deadlock the supervisor.
            await self._terminate_process(process)
            raise
        finally:
            if not stderr_task.done() and self._stop_event.is_set():
                stderr_task.cancel()
            try:
                stderr = await stderr_task
            except asyncio.CancelledError:
                stderr = ""
        return int(return_code or 0), needs_resync, saw_event, stderr

    async def _watch_supervisor(self, first_process: Any) -> None:
        process: Any = first_process
        attempts = 0
        resync_pending = False
        try:
            while not self._stop_event.is_set():
                if resync_pending:
                    try:
                        bootstrap_cursor = await self._load_directory()
                        self._persist_cursor(bootstrap_cursor)
                        resync_pending = False
                        attempts = 0
                    except CliFailure as failure:
                        if not failure.retryable:
                            await self._supervisor_fatal(failure)
                            return
                        attempts += 1
                        await self._backoff(attempts, failure.retry_after)
                        continue

                if process is None:
                    try:
                        process = await self._spawn_watch()
                        self._watch_process = process
                    except CliFailure as failure:
                        if not failure.retryable:
                            await self._supervisor_fatal(failure)
                            return
                        attempts += 1
                        await self._backoff(attempts, failure.retry_after)
                        continue

                try:
                    return_code, needs_resync, saw_event, stderr = await self._consume_watch(
                        process
                    )
                except CliFailure as failure:
                    await self._terminate_process(process)
                    if not failure.retryable:
                        await self._supervisor_fatal(failure)
                        return
                    return_code, needs_resync, saw_event, stderr = (
                        failure.exit_code,
                        False,
                        False,
                        "",
                    )
                process = None

                if self._stop_event.is_set():
                    return

                if needs_resync:
                    resync_pending = True
                elif return_code != 0:
                    failure = _watch_failure_from_exit(return_code, stderr)
                    if not failure.retryable:
                        await self._supervisor_fatal(failure)
                        return
                    attempts = 0 if saw_event else attempts + 1
                    await self._backoff(attempts, failure.retry_after)
                else:
                    attempts = 0 if saw_event else attempts + 1
                    await self._backoff(attempts, None)

                if self._stop_event.is_set():
                    return
        except asyncio.CancelledError:
            raise
        except CliFailure as failure:
            await self._supervisor_fatal(failure)
        except Exception:
            await self._supervisor_fatal(
                CliFailure(
                    5,
                    "WATCH_SUPERVISOR_FAILED",
                    "Hype Comms watch supervisor failed",
                    True,
                    error_kind="transient",
                )
            )
        finally:
            self._watch_process = None

    async def _backoff(self, attempt: int, requested_delay: Optional[float]) -> None:
        cap = min(self._backoff_max, self._backoff_base * (2 ** min(max(attempt, 0), 8)))
        # Mirror packages/cli/src/watch.ts: use the full backoff step as a
        # floor plus a small jitter fraction, rather than a uniform draw
        # over [0, cap). A floorless draw can land near zero on repeated
        # retries and respawn the watch subprocess in a tight loop.
        jitter = random.random() * 0.25 * cap
        delay = min(self._backoff_max, cap + jitter)
        if requested_delay is not None:
            # A server-requested delay extends the wait, it never shortens it --
            # `Math.max(base + jitter, requestedRetryDelay)` in watch.ts. Retry-After: 0,
            # or an HTTP-date already elapsed when the CLI parsed it, arrives here as 0.0
            # and would otherwise erase the floor and hammer the endpoint that just asked
            # us to back off. Still capped, so a hostile or misconfigured Retry-After
            # cannot park the adapter indefinitely.
            delay = max(delay, min(self._backoff_max, requested_delay))
        if delay <= 0:
            await asyncio.sleep(0)
            return
        try:
            await asyncio.wait_for(self._stop_event.wait(), timeout=delay)
        except asyncio.TimeoutError:
            pass

    async def _supervisor_fatal(self, failure: CliFailure) -> None:
        logger.error("Hype Comms watch stopped: %s", failure)
        self._set_fatal_error(failure.code, failure.message, retryable=failure.retryable)
        self._mark_disconnected()
        await self._notify_fatal_error()

    async def _terminate_process(self, process: Any) -> None:
        if process is None or process.returncode is not None:
            return
        try:
            process.terminate()
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(process.wait(), timeout=3.0)
        except asyncio.TimeoutError:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            try:
                await process.wait()
            except Exception:
                pass

    @staticmethod
    def _event_timestamp(value: object) -> datetime:
        if not isinstance(value, str):
            return datetime.now(timezone.utc)
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return datetime.now(timezone.utc)
        return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)

    def _chat_info(self, chat_id: str) -> Optional[Dict[str, Any]]:
        entry = self._conversations.get(chat_id)
        if entry is None:
            return None
        conversation = entry["conversation"]
        participant_ids = entry["participantIds"]
        kind = conversation.get("kind")
        if kind == "direct_message":
            other_ids = [
                participant_id
                for participant_id in participant_ids
                if participant_id != self._agent_user_id
            ]
            other = self._members.get(other_ids[0]) if other_ids else None
            name = (
                (other or {}).get("displayName")
                or (f"@{other.get('username')}" if other and other.get("username") else None)
                or conversation.get("name")
                or "Direct message"
            )
            chat_type = "dm"
        else:
            name = conversation.get("name") or (
                f"#{conversation.get('slug')}" if conversation.get("slug") else chat_id
            )
            chat_type = "channel"
        return {
            "id": chat_id,
            "name": str(name),
            "type": chat_type,
            "topic": conversation.get("topic"),
            "slug": conversation.get("slug"),
            "is_archived": bool(conversation.get("isArchived")),
            "participant_ids": list(participant_ids),
        }

    def _cache_conversation_event(self, event: Mapping[str, Any]) -> None:
        payload = event.get("payload")
        if not isinstance(payload, dict):
            raise CliFailure(
                6,
                "INVALID_CONVERSATION_EVENT",
                "Hype Comms watch emitted invalid conversation metadata",
                False,
            )
        conversation = payload.get("conversation")
        participant_ids = payload.get("participantIds")
        if (
            not isinstance(conversation, dict)
            or not isinstance(conversation.get("id"), str)
            or not isinstance(participant_ids, list)
            or not all(isinstance(item, str) for item in participant_ids)
        ):
            raise CliFailure(
                6,
                "INVALID_CONVERSATION_EVENT",
                "Hype Comms watch emitted invalid conversation metadata",
                False,
            )
        self._conversations[str(conversation["id"])] = {
            "conversation": dict(conversation),
            "participantIds": list(participant_ids),
        }

    async def _refresh_directory_for_event(self, reason: str) -> None:
        """Refresh the directory from inside the watch loop without risking a fatal stop.

        `_load_directory()` classifies most of its own failures as non-retryable, which is right
        for its connect-time caller: a malformed bootstrap there is a config problem worth giving
        up on. On the event path it is wrong. An unhandled non-retryable failure propagates
        through `_consume_watch` into `_supervisor_fatal` and stops the adapter permanently over
        what is at worst a transient refresh the CLI may answer differently next time.

        Re-raised as exit code 5 specifically, not merely `retryable=True`: `_watch_supervisor`
        re-derives retryability from the exit code via `_watch_failure_from_exit`, and only exit 5
        survives that second pass. Callers must not persist the cursor afterwards, so the event is
        redelivered on reconnect and the refresh is retried rather than silently skipped.
        """

        try:
            await self._load_directory()
        except CliFailure as failure:
            logger.warning(
                "Deferring %s directory refresh after %s: %s",
                reason,
                failure.code,
                _safe_text(failure.message),
            )
            raise replace(
                failure,
                exit_code=5,
                code="DIRECTORY_REFRESH_FAILED",
                message="Hype Comms directory refresh failed and will be retried",
                retryable=True,
                error_kind="transient",
            ) from failure

    async def _handle_membership_changed(self, event: Mapping[str, Any]) -> None:
        # The payload only ever carries {memberId, action} -- never a
        # conversation object or participant list (contrast with
        # channel.created / channel.archived / direct_conversation.created,
        # which do). Never trust display fields off the event itself; when
        # we lack enough information locally, refresh from the validated,
        # authoritative _load_directory() CLI responses instead of guessing.
        payload = event.get("payload")
        member_id = payload.get("memberId") if isinstance(payload, dict) else None
        action = payload.get("action") if isinstance(payload, dict) else None
        conversation_id = event.get("conversationId")
        if (
            not isinstance(payload, dict)
            or not isinstance(member_id, str)
            or action not in {"added", "updated", "removed"}
            or not isinstance(conversation_id, str)
        ):
            raise CliFailure(
                6,
                "INVALID_MEMBERSHIP_EVENT",
                "Hype Comms watch emitted invalid membership metadata",
                False,
            )

        if action == "updated":
            # A per-conversation membership attribute (e.g. role) changed.
            # The adapter's conversation cache only tracks participant ids
            # and conversation metadata, not per-member roles, so there is
            # nothing to refresh.
            return

        if member_id == self._agent_user_id:
            if action == "removed":
                # The agent lost access to this conversation. Drop the now-
                # inaccessible entry instead of leaving stale metadata (and
                # a stale participant list) cached.
                self._conversations.pop(conversation_id, None)
                return
            # action == "added": the agent gained access to a conversation
            # it may never have seen before (e.g. added to an existing
            # channel it wasn't previously a member of). The event carries
            # no conversation payload to cache, so a full directory refresh
            # is the only authoritative way to learn its metadata.
            await self._refresh_directory_for_event("channel.membership_changed")
            return

        entry = self._conversations.get(conversation_id)
        if entry is None:
            if action == "added":
                # An unfamiliar conversation gained a member. Refresh in
                # case this is a conversation the adapter hasn't loaded yet
                # (e.g. a race with the initial directory load).
                await self._refresh_directory_for_event("channel.membership_changed")
            # action == "removed" for a conversation we don't have cached:
            # the cache is already consistent with that outcome.
            return

        # We already have this conversation cached, and only its
        # participant set needs to change -- a full reload is unnecessary
        # here, which keeps a burst of membership events cheap.
        participant_ids = list(entry["participantIds"])
        if action == "added":
            if member_id not in participant_ids:
                participant_ids.append(member_id)
        else:  # action == "removed"
            if member_id in participant_ids:
                participant_ids.remove(member_id)
        self._conversations[conversation_id] = {
            "conversation": entry["conversation"],
            "participantIds": participant_ids,
        }

    async def _dispatch_message(self, event: Mapping[str, Any]) -> None:
        payload = event.get("payload")
        if not isinstance(payload, dict):
            raise CliFailure(
                6,
                "INVALID_MESSAGE_EVENT",
                "Hype Comms watch emitted invalid message metadata",
                False,
            )
        message = payload.get("message")
        mentioned_user_ids = payload.get("mentionedUserIds")
        if (
            not isinstance(message, dict)
            or not isinstance(message.get("id"), str)
            or not isinstance(message.get("conversationId"), str)
            or not isinstance(message.get("body"), str)
            or not isinstance(mentioned_user_ids, list)
            or not all(isinstance(item, str) for item in mentioned_user_ids)
        ):
            raise CliFailure(
                6,
                "INVALID_MESSAGE_EVENT",
                "Hype Comms watch emitted invalid message metadata",
                False,
            )

        author_id = message.get("authorId")
        if author_id == self._agent_user_id:
            return
        if not isinstance(author_id, str):
            logger.warning("Ignoring Hype Comms message without an active author")
            return

        conversation_id = str(message["conversationId"])
        chat_info = self._chat_info(conversation_id)
        author = self._members.get(author_id)
        if chat_info is None or author is None:
            # A metadata update may have raced the message. Refresh from
            # validated CLI responses; never trust display fields from the
            # message event itself. Go through _refresh_directory_for_event so
            # a non-retryable refresh failure is re-raised as retryable rather
            # than stopping the adapter permanently.
            await self._refresh_directory_for_event("message.created")
            chat_info = self._chat_info(conversation_id)
            author = self._members.get(author_id)
        if chat_info is None or author is None:
            logger.warning("Ignoring Hype Comms message with unresolved directory metadata")
            return
        if chat_info["type"] == "channel" and self._agent_user_id not in mentioned_user_ids:
            return

        source = self.build_source(
            chat_id=conversation_id,
            chat_name=chat_info["name"],
            chat_type=chat_info["type"],
            user_id=author_id,
            user_name=str(author.get("username") or author.get("displayName") or author_id),
            # Hermes's durable SessionStore uses gateway-wide isolation flags,
            # not PlatformConfig.extra. A stable synthetic thread lane makes
            # its default thread_sessions_per_user=False key conversation-
            # scoped while retaining user_id for authorization and attribution.
            thread_id=conversation_id if chat_info["type"] == "channel" else None,
            chat_topic=chat_info.get("topic"),
            scope_id=self._workspace_id,
            message_id=str(message["id"]),
        )
        normalized = MessageEvent(
            text=str(message["body"]),
            message_type=MessageType.TEXT,
            source=source,
            raw_message={
                "platform": PLATFORM_NAME,
                "workspaceSequence": event.get("workspaceSequence"),
                "mentionedUserIds": list(mentioned_user_ids),
            },
            message_id=str(message["id"]),
            timestamp=self._event_timestamp(message.get("createdAt") or event.get("occurredAt")),
            metadata={
                "hype_comms_workspace_sequence": event.get("workspaceSequence"),
                "hype_comms_conversation_sequence": message.get("conversationSequence"),
            },
        )
        await self.handle_message(normalized)

    async def _accept_event(self, event: Mapping[str, Any]) -> str:
        event_type = event.get("type")
        if not isinstance(event_type, str):
            raise CliFailure(
                6,
                "UNSUPPORTED_WATCH_EVENT",
                "Hype Comms watch emitted an unsupported event",
                False,
                error_kind="bad_format",
            )
        if event_type not in SUPPORTED_EVENT_TYPES:
            # Unknown event types must not be fatal: the server contract can
            # grow new event types (e.g. reaction.added, system.error) ahead
            # of this adapter's support for them. Ignore before the
            # workspaceId check below, since system.error carries a nullable
            # workspaceId that would otherwise trip WORKSPACE_MISMATCH. Do
            # not advance the cursor; a later recognized event, or a
            # reconnect replay, will pass over this one again harmlessly.
            logger.debug(
                "Ignoring unsupported Hype Comms watch event type: %s", _safe_text(event_type)
            )
            return "ignored"
        if event.get("workspaceId") != self._workspace_id:
            raise CliFailure(
                6,
                "WORKSPACE_MISMATCH",
                "Hype Comms watch emitted an event for another workspace",
                False,
                error_kind="bad_format",
            )
        cursor = self._checked_cursor(event.get("workspaceSequence"))
        if event_type == "system.resync_required":
            return "resync"
        if self._cursor is not None and int(cursor) <= int(self._cursor):
            return "duplicate"
        if event_type == "member.updated":
            payload = event.get("payload")
            member = payload.get("member") if isinstance(payload, dict) else None
            if not isinstance(member, dict) or not isinstance(member.get("id"), str):
                raise CliFailure(
                    6,
                    "INVALID_MEMBER_EVENT",
                    "Hype Comms watch emitted invalid member metadata",
                    False,
                )
            # The payload is advisory: it announces THAT the workspace member
            # directory changed, not what it now is. The wire member shape
            # cannot express removal (it carries no status flag), so a
            # disabled agent arrives here looking exactly like an active one
            # -- patching `self._members` from it would re-assert the member
            # the event was emitted to retire. Re-read the directory instead,
            # the same way _handle_membership_changed does whenever the
            # cached state cannot be patched from the payload. bootstrap's
            # `members` is already active-only, and _load_directory() re-pins
            # the agent's own record, so the agent can never delete itself.
            # Discard the returned bootstrap cursor: the watch cursor is
            # advanced below from this event's own workspaceSequence, and
            # assigning the bootstrap cursor here would rewind or jump it.
            await self._refresh_directory_for_event("member.updated")
        elif event_type in {
            "channel.created",
            "channel.archived",
            "direct_conversation.created",
        }:
            self._cache_conversation_event(event)
        elif event_type == "channel.membership_changed":
            await self._handle_membership_changed(event)
        elif event_type == "message.created":
            await self._dispatch_message(event)

        self._persist_cursor(cursor)
        return "accepted"

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        del reply_to, metadata
        if self.message_len_fn(content) > MAX_MESSAGE_LENGTH:
            return SendResult(
                success=False,
                error="MESSAGE_TOO_LONG: Hype Comms messages are limited to 4000 characters",
                retryable=False,
                error_kind="too_long",
            )
        try:
            result = await self._command(
                ["messages", "send", str(chat_id), "--json"],
                stdin_text=content,
            )
            return SendResult(success=True, message_id=_message_id(result))
        except CliFailure as failure:
            return SendResult(
                success=False,
                error=str(failure),
                raw_response=failure.safe_metadata(),
                retryable=failure.retryable,
                retry_after=failure.retry_after,
                error_kind=failure.error_kind,
            )
        except ValueError as exc:
            return SendResult(
                success=False,
                error=f"CONFIG_INVALID: {_safe_text(exc)}",
                retryable=False,
                error_kind="bad_format",
            )

    async def send_typing(
        self,
        chat_id: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        del chat_id, metadata

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        info = self._chat_info(str(chat_id))
        if info is not None:
            return dict(info)
        return {"id": str(chat_id), "name": str(chat_id), "type": "channel"}

    async def disconnect(self) -> None:
        self._stop_event.set()
        process = self._watch_process
        if process is not None:
            await self._terminate_process(process)
        task = self._watch_task
        if task is not None and task is not asyncio.current_task():
            try:
                await asyncio.wait_for(task, timeout=5.0)
            except asyncio.TimeoutError:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        self._watch_task = None
        self._watch_process = None
        if self._lock_held:
            self._release_platform_lock()
            self._lock_held = False
        self._mark_disconnected()
        logger.info("Hype Comms adapter disconnected")


def check_requirements() -> bool:
    try:
        _configured_origin()
        _configured_token()
    except ValueError:
        return False
    return _has_access_policy() and shutil.which(_cli_path()) is not None


def validate_config(config: PlatformConfig) -> bool:
    try:
        _configured_origin(config)
        _configured_token()
    except ValueError:
        return False
    return _has_access_policy() and bool(_cli_path(config))


def is_connected(config: PlatformConfig) -> bool:
    return validate_config(config)


def _env_enablement() -> Optional[Dict[str, Any]]:
    try:
        origin = _configured_origin()
        _configured_token()
    except ValueError:
        return None
    if not _has_access_policy():
        return None
    seed: Dict[str, Any] = {
        "api_origin": origin,
        **CONVERSATION_SESSION_EXTRA,
    }
    cli_path = os.getenv("HYPE_COMMS_CLI_PATH", "").strip()
    if cli_path:
        seed["cli_path"] = cli_path
    home = os.getenv("HYPE_COMMS_HOME_CONVERSATION", "").strip()
    if home:
        seed["home_channel"] = {
            "chat_id": home,
            "name": "Hype Comms home conversation",
        }
    return seed


def register(ctx: Any) -> None:
    """Hermes plugin entry point."""

    ctx.register_platform(
        name=PLATFORM_NAME,
        label="Hype Comms",
        adapter_factory=lambda cfg: HypeCommsAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=["HYPE_COMMS_API_ORIGIN", "HYPE_COMMS_TOKEN"],
        install_hint="Install hype-comms-cli and configure an Hype Comms agent token",
        env_enablement_fn=_env_enablement,
        cron_deliver_env_var="HYPE_COMMS_HOME_CONVERSATION",
        standalone_sender_fn=_standalone_send,
        allowed_users_env="HYPE_COMMS_ALLOWED_USERS",
        allow_all_env="HYPE_COMMS_ALLOW_ALL_USERS",
        max_message_length=MAX_MESSAGE_LENGTH,
        emoji="💭",
        pii_safe=False,
        allow_update_command=True,
        platform_hint=(
            "You are chatting through Hype Comms. Direct messages always wake you; "
            "channel messages wake you only when they explicitly mention your Hype Comms user. "
            "Replies return to the same conversation. Hype Comms supports markdown and limits "
            "each message to 4,000 characters."
        ),
    )
