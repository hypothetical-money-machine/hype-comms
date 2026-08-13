"""Fake-process tests for the drop-in Hermes Hype Comms adapter.

The real Hermes package is intentionally not required. The small module fakes
below preserve the import paths and method contracts used by upstream Hermes.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import stat
import sys
import tempfile
import types
import unittest
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional
from unittest.mock import patch


class FakePlatform:
    _instances: dict[str, "FakePlatform"] = {}

    def __new__(cls, value: str):
        if value not in cls._instances:
            instance = super().__new__(cls)
            instance.value = value
            cls._instances[value] = instance
        return cls._instances[value]


@dataclass
class FakePlatformConfig:
    extra: dict[str, Any] = field(default_factory=dict)


class FakeMessageType:
    TEXT = "text"


@dataclass
class FakeMessageEvent:
    text: str
    message_type: str
    source: Any
    raw_message: Any = None
    message_id: Optional[str] = None
    timestamp: Any = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class FakeSendResult:
    success: bool
    message_id: Optional[str] = None
    error: Optional[str] = None
    raw_response: Any = None
    retryable: bool = False
    retry_after: Optional[float] = None
    continuation_message_ids: tuple[Any, ...] = ()
    error_kind: Optional[str] = None


class FakeBasePlatformAdapter:
    def __init__(self, config: FakePlatformConfig, platform: FakePlatform):
        self.config = config
        self.platform = platform
        self._running = False
        self.handled_events: list[FakeMessageEvent] = []
        self.session_keys: list[str] = []
        self.lock_calls: list[tuple[str, str, str]] = []
        self.release_count = 0
        self.fatal_error: Optional[tuple[str, str, bool]] = None

    def _acquire_platform_lock(self, scope: str, identity: str, description: str) -> bool:
        self.lock_calls.append((scope, identity, description))
        return bool(self.config.extra.get("lock_success", True))

    def _release_platform_lock(self) -> None:
        self.release_count += 1

    def _mark_connected(self) -> None:
        self._running = True

    def _mark_disconnected(self) -> None:
        self._running = False

    def _set_fatal_error(self, code: str, message: str, retryable: bool = True) -> None:
        self.fatal_error = (code, message, retryable)

    async def _notify_fatal_error(self) -> None:
        return None

    def build_source(self, **kwargs: Any) -> Any:
        return types.SimpleNamespace(platform=self.platform, **kwargs)

    async def handle_message(self, event: FakeMessageEvent) -> None:
        self.handled_events.append(event)
        source = event.source
        parts = [source.platform.value, source.chat_type, source.chat_id]
        if source.thread_id:
            parts.append(source.thread_id)
        isolate_user = bool(
            self.config.extra.get("group_sessions_per_user", True)
        )
        if source.thread_id and not bool(
            self.config.extra.get("thread_sessions_per_user", False)
        ):
            isolate_user = False
        if isolate_user and source.user_id:
            parts.append(source.user_id)
        self.session_keys.append(":".join(parts))


def _install_fake_hermes() -> None:
    gateway = types.ModuleType("gateway")
    gateway.__path__ = []
    config = types.ModuleType("gateway.config")
    config.Platform = FakePlatform
    config.PlatformConfig = FakePlatformConfig
    platforms = types.ModuleType("gateway.platforms")
    platforms.__path__ = []
    base = types.ModuleType("gateway.platforms.base")
    base.BasePlatformAdapter = FakeBasePlatformAdapter
    base.MessageEvent = FakeMessageEvent
    base.MessageType = FakeMessageType
    base.SendResult = FakeSendResult
    sys.modules.update(
        {
            "gateway": gateway,
            "gateway.config": config,
            "gateway.platforms": platforms,
            "gateway.platforms.base": base,
        }
    )


_install_fake_hermes()
_ADAPTER_PATH = Path(__file__).with_name("adapter.py")
_SPEC = importlib.util.spec_from_file_location("hype_comms_adapter_under_test", _ADAPTER_PATH)
assert _SPEC is not None and _SPEC.loader is not None
adapter_module = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = adapter_module
_SPEC.loader.exec_module(adapter_module)


AGENT_ID = "00000000-0000-4000-8000-000000000001"
USER_ID = "00000000-0000-4000-8000-000000000002"
SECOND_USER_ID = "00000000-0000-4000-8000-000000000003"
PEER_AGENT_ID = "00000000-0000-4000-8000-000000000004"
WORKSPACE_ID = "00000000-0000-4000-8000-000000000010"
DM_ID = "00000000-0000-4000-8000-000000000020"
CHANNEL_ID = "00000000-0000-4000-8000-000000000021"
PEER_AGENT_DM_ID = "00000000-0000-4000-8000-000000000023"
NEW_CHANNEL_ID = "00000000-0000-4000-8000-000000000024"
UNKNOWN_CHANNEL_ID = "00000000-0000-4000-8000-000000000025"
MESSAGE_ID = "00000000-0000-4000-8000-000000000030"
ORIGIN = "https://chat.example.test"


def user(user_id: str, username: str, display_name: str) -> dict[str, Any]:
    return {"id": user_id, "username": username, "displayName": display_name}


AGENT_USER = user(AGENT_ID, "hermes", "Hermes")
HUMAN_USER = user(USER_ID, "morgan", "Morgan")
PEER_AGENT_USER = user(PEER_AGENT_ID, "atlas", "Atlas")


def principal() -> dict[str, Any]:
    return {
        "type": "agent",
        "user": AGENT_USER,
        "workspaceId": WORKSPACE_ID,
        "role": "member",
        "scopes": ["workspace:read", "messages:write"],
    }


def conversation(
    conversation_id: str,
    kind: str,
    participants: list[str],
    *,
    name: Optional[str] = None,
    slug: Optional[str] = None,
    topic: Optional[str] = None,
    archived: bool = False,
) -> dict[str, Any]:
    return {
        "conversation": {
            "id": conversation_id,
            "workspaceId": WORKSPACE_ID,
            "kind": kind,
            "name": name,
            "slug": slug,
            "topic": topic,
            "isArchived": archived,
        },
        "participantIds": participants,
    }


DM_SUMMARY = conversation(DM_ID, "direct_message", [AGENT_ID, USER_ID])
PEER_AGENT_DM_SUMMARY = conversation(
    PEER_AGENT_DM_ID, "direct_message", [AGENT_ID, PEER_AGENT_ID]
)
CHANNEL_SUMMARY = conversation(
    CHANNEL_ID,
    "channel",
    [],
    name="General",
    slug="general",
    topic="General discussion",
)


def bootstrap(
    cursor: str = "100",
    members: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    return {
        "currentUser": principal(),
        "workspace": {"id": WORKSPACE_ID, "name": "Hype Comms"},
        "syncCursor": cursor,
        # bootstrap.members is already active-only server-side, so a disabled
        # agent simply stops appearing here.
        "members": [AGENT_USER, HUMAN_USER] if members is None else list(members),
    }


def event(
    event_type: str,
    cursor: str,
    payload: dict[str, Any],
    *,
    conversation_id: Optional[str] = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "type": event_type,
        "workspaceId": WORKSPACE_ID,
        "workspaceSequence": cursor,
        "occurredAt": "2026-07-26T12:00:00.000Z",
        "payload": payload,
    }
    if conversation_id is not None:
        result["conversationId"] = conversation_id
    return result


def membership_changed_event(
    cursor: str,
    conversation_id: str,
    member_id: str,
    action: str,
) -> dict[str, Any]:
    return event(
        "channel.membership_changed",
        cursor,
        {"memberId": member_id, "action": action},
        conversation_id=conversation_id,
    )


def message_event(
    cursor: str,
    conversation_id: str,
    author_id: Optional[str],
    *,
    mentions: Optional[list[str]] = None,
    body: str = "hello",
) -> dict[str, Any]:
    return event(
        "message.created",
        cursor,
        {
            "message": {
                "id": f"{MESSAGE_ID[:-3]}{int(cursor):03d}",
                "conversationId": conversation_id,
                "conversationSequence": cursor,
                "authorId": author_id,
                "body": body,
                "createdAt": "2026-07-26T12:00:00.000Z",
            },
            "mentionedUserIds": list(mentions or []),
        },
    )


class FakeStream:
    def __init__(self, lines: list[bytes], *, closed: bool):
        self._queue: asyncio.Queue[bytes] = asyncio.Queue()
        for line in lines:
            self._queue.put_nowait(line)
        self._closed = False
        if closed:
            self.close()

    async def readline(self) -> bytes:
        return await self._queue.get()

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            self._queue.put_nowait(b"")


class FakeProcess:
    def __init__(
        self,
        *,
        stdout: bytes = b"{}",
        stderr: bytes = b"",
        returncode: int = 0,
    ):
        self._communicate_stdout = stdout
        self._communicate_stderr = stderr
        self.returncode: Optional[int] = returncode
        self.input: Optional[bytes] = None
        self.stdout = None
        self.stderr = None

    async def communicate(self, input: Optional[bytes] = None) -> tuple[bytes, bytes]:
        self.input = input
        return self._communicate_stdout, self._communicate_stderr

    async def wait(self) -> int:
        return int(self.returncode or 0)

    def kill(self) -> None:
        if self.returncode is None:
            self.returncode = -9


class FakeWatchProcess:
    def __init__(
        self,
        lines: Optional[list[bytes]] = None,
        *,
        stderr_lines: Optional[list[bytes]] = None,
        returncode: int = 0,
        blocking: bool = False,
    ):
        self.returncode: Optional[int] = None if blocking else returncode
        self.stdout = FakeStream(list(lines or []), closed=not blocking)
        self.stderr = FakeStream(list(stderr_lines or []), closed=not blocking)
        self._done = asyncio.Event()
        if not blocking:
            self._done.set()
        self.terminated = False
        self.killed = False

    async def wait(self) -> int:
        await self._done.wait()
        return int(self.returncode or 0)

    def terminate(self) -> None:
        self.terminated = True
        if self.returncode is None:
            self.returncode = -15
        self.stdout.close()
        self.stderr.close()
        self._done.set()

    def kill(self) -> None:
        self.killed = True
        if self.returncode is None:
            self.returncode = -9
        self.stdout.close()
        self.stderr.close()
        self._done.set()


@dataclass
class ProcessSpec:
    args: tuple[str, ...]
    result: Any


class FakeProcessFactory:
    def __init__(self, specs: list[ProcessSpec]):
        self.specs = deque(specs)
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, cli: str, *args: str, **kwargs: Any) -> Any:
        if not self.specs:
            raise AssertionError(f"Unexpected CLI call: {args!r}")
        spec = self.specs.popleft()
        if tuple(args) != spec.args:
            raise AssertionError(f"Expected {spec.args!r}, got {args!r}")
        self.calls.append({"cli": cli, "args": tuple(args), "kwargs": kwargs, "process": spec.result})
        if isinstance(spec.result, BaseException):
            raise spec.result
        return spec.result


def json_process(value: dict[str, Any]) -> FakeProcess:
    return FakeProcess(stdout=json.dumps(value).encode("utf-8"))


def directory_reload_specs(
    cursor: str,
    members: Optional[list[dict[str, Any]]] = None,
    conversations: Optional[list[dict[str, Any]]] = None,
) -> list[ProcessSpec]:
    """The two CLI calls `_load_directory()` issues, in order."""

    return [
        ProcessSpec(
            ("workspace", "bootstrap", "--json"),
            json_process(bootstrap(cursor, members)),
        ),
        ProcessSpec(
            ("conversations", "list", "--all", "--json"),
            json_process(
                {
                    "conversations": list(
                        [DM_SUMMARY, CHANNEL_SUMMARY] if conversations is None else conversations
                    ),
                    "nextCursor": None,
                    "hasMore": False,
                }
            ),
        ),
    ]


def startup_specs(cursor: str = "100") -> list[ProcessSpec]:
    return [
        ProcessSpec(("auth", "whoami", "--json"), json_process(principal())),
        ProcessSpec(("workspace", "bootstrap", "--json"), json_process(bootstrap(cursor))),
        ProcessSpec(
            ("conversations", "list", "--all", "--json"),
            json_process(
                {
                    "conversations": [DM_SUMMARY, CHANNEL_SUMMARY],
                    "nextCursor": None,
                    "hasMore": False,
                }
            ),
        ),
    ]


class AdapterTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = patch.dict(
            os.environ,
            {
                "HYPE_COMMS_API_ORIGIN": ORIGIN,
                "HYPE_COMMS_TOKEN": "unit-test-token",
                "HYPE_COMMS_ALLOWED_USERS": USER_ID,
                "HYPE_COMMS_ALLOW_ALL_USERS": "false",
                "HYPE_COMMS_CLI_PATH": "hype-comms-cli",
            },
        )
        self.env.start()
        self.addCleanup(self.env.stop)

    def new_adapter(
        self,
        factory: FakeProcessFactory,
        *,
        config: Optional[FakePlatformConfig] = None,
    ) -> Any:
        return adapter_module.HypeCommsAdapter(
            config or FakePlatformConfig(),
            process_factory=factory,
            state_dir=Path(self.temp.name),
        )

    def prepare_adapter(self, adapter: Any, cursor: str = "100") -> None:
        adapter._api_origin = ORIGIN
        adapter._agent_user_id = AGENT_ID
        adapter._workspace_id = WORKSPACE_ID
        adapter._agent_user = dict(AGENT_USER)
        adapter._members = {AGENT_ID: dict(AGENT_USER), USER_ID: dict(HUMAN_USER)}
        adapter._conversations = {
            DM_ID: {
                "conversation": dict(DM_SUMMARY["conversation"]),
                "participantIds": list(DM_SUMMARY["participantIds"]),
            },
            CHANNEL_ID: {
                "conversation": dict(CHANNEL_SUMMARY["conversation"]),
                "participantIds": list(CHANNEL_SUMMARY["participantIds"]),
            },
        }
        adapter._cursor_path = adapter._select_cursor_path()
        adapter._persist_cursor(cursor)

    async def test_connect_bootstraps_at_current_cursor_and_keeps_token_off_argv(self) -> None:
        watch = FakeWatchProcess(blocking=True)
        factory = FakeProcessFactory(
            startup_specs() + [ProcessSpec(("watch", "--json", "--after", "100"), watch)]
        )
        adapter = self.new_adapter(factory)

        self.assertTrue(await adapter.connect())
        self.assertEqual(
            [call["args"] for call in factory.calls],
            [
                ("auth", "whoami", "--json"),
                ("workspace", "bootstrap", "--json"),
                ("conversations", "list", "--all", "--json"),
                ("watch", "--json", "--after", "100"),
            ],
        )
        for call in factory.calls:
            self.assertNotIn("unit-test-token", call["args"])
        self.assertEqual(adapter.lock_calls[0][0], "hype-comms-agent")
        self.assertIn(AGENT_ID, adapter.lock_calls[0][1])
        self.assertEqual(
            stat.S_IMODE(adapter._cursor_path.stat().st_mode),
            0o600,
        )

        await adapter.disconnect()
        self.assertTrue(watch.terminated)
        self.assertEqual(adapter.release_count, 1)

    async def test_dm_mentions_and_self_suppression_checkpoint_without_channel_leakage(self) -> None:
        adapter = self.new_adapter(FakeProcessFactory([]))
        self.prepare_adapter(adapter)

        await adapter._accept_event(message_event("101", DM_ID, USER_ID, body="dm"))
        await adapter._accept_event(
            message_event("102", CHANNEL_ID, USER_ID, body="background channel traffic")
        )
        await adapter._accept_event(
            message_event(
                "103",
                CHANNEL_ID,
                USER_ID,
                mentions=[AGENT_ID],
                body="@hermes wake up",
            )
        )
        await adapter._accept_event(
            message_event("104", DM_ID, AGENT_ID, body="the adapter's own reply")
        )

        self.assertEqual([item.text for item in adapter.handled_events], ["dm", "@hermes wake up"])
        self.assertEqual(adapter.handled_events[0].source.chat_type, "dm")
        self.assertEqual(adapter.handled_events[1].source.chat_type, "channel")
        self.assertEqual(adapter.handled_events[1].source.user_id, USER_ID)
        self.assertEqual(adapter.handled_events[1].source.user_name, "morgan")
        self.assertEqual(adapter._cursor, "104")

    async def test_channel_authors_share_one_conversation_session(self) -> None:
        original_extra = {
            "cli_path": "/opt/hype-comms-cli",
            "group_sessions_per_user": True,
            "thread_sessions_per_user": True,
        }
        config = FakePlatformConfig(extra=original_extra)
        adapter = self.new_adapter(FakeProcessFactory([]), config=config)
        self.prepare_adapter(adapter)
        adapter._members[SECOND_USER_ID] = user(
            SECOND_USER_ID,
            "alex",
            "Alex",
        )

        await adapter._accept_event(
            message_event(
                "101",
                CHANNEL_ID,
                USER_ID,
                mentions=[AGENT_ID],
                body="@hermes from Morgan",
            )
        )
        await adapter._accept_event(
            message_event(
                "102",
                CHANNEL_ID,
                SECOND_USER_ID,
                mentions=[AGENT_ID],
                body="@hermes from Alex",
            )
        )

        self.assertIsNot(config.extra, original_extra)
        self.assertEqual(config.extra["cli_path"], "/opt/hype-comms-cli")
        self.assertFalse(config.extra["group_sessions_per_user"])
        self.assertFalse(config.extra["thread_sessions_per_user"])
        self.assertEqual(
            [item.source.user_id for item in adapter.handled_events],
            [USER_ID, SECOND_USER_ID],
        )
        self.assertEqual(
            [item.source.thread_id for item in adapter.handled_events],
            [CHANNEL_ID, CHANNEL_ID],
        )
        self.assertEqual(adapter.session_keys[0], adapter.session_keys[1])

    async def test_connect_rejects_author_isolating_thread_configuration(self) -> None:
        factory = FakeProcessFactory([])
        adapter = self.new_adapter(factory)
        adapter.gateway_runner = types.SimpleNamespace(
            config=types.SimpleNamespace(
                group_sessions_per_user=True,
                thread_sessions_per_user=True,
            )
        )

        self.assertFalse(await adapter.connect())
        self.assertEqual(factory.calls, [])
        self.assertEqual(
            adapter.fatal_error,
            (
                "INCOMPATIBLE_HERMES_SESSION_CONFIG",
                (
                    "Hype Comms requires shared Hermes thread sessions; "
                    "disable gateway.thread_sessions_per_user"
                ),
                False,
            ),
        )

    async def test_member_and_conversation_updates_refresh_cached_chat_info(self) -> None:
        renamed = user(USER_ID, "morgan", "Morgan Renamed")
        new_channel_id = "00000000-0000-4000-8000-000000000022"
        # member.updated only announces THAT the directory changed, so the
        # refreshed display name has to arrive via the reload, not the payload.
        factory = FakeProcessFactory(directory_reload_specs("150", [AGENT_USER, renamed]))
        adapter = self.new_adapter(factory)
        self.prepare_adapter(adapter)

        await adapter._accept_event(event("member.updated", "101", {"member": renamed}))
        await adapter._accept_event(
            event(
                "channel.created",
                "102",
                {
                    "conversation": conversation(
                        new_channel_id,
                        "channel",
                        [],
                        name="Operations",
                        slug="operations",
                        topic="Ship room",
                    )["conversation"],
                    "participantIds": [],
                },
            )
        )

        self.assertEqual((await adapter.get_chat_info(DM_ID))["name"], "Morgan Renamed")
        self.assertEqual((await adapter.get_chat_info(new_channel_id))["topic"], "Ship room")
        self.assertEqual(adapter._cursor, "102")

    def add_peer_agent(self, adapter: Any) -> None:
        adapter._members[PEER_AGENT_ID] = dict(PEER_AGENT_USER)
        adapter._conversations[PEER_AGENT_DM_ID] = {
            "conversation": dict(PEER_AGENT_DM_SUMMARY["conversation"]),
            "participantIds": list(PEER_AGENT_DM_SUMMARY["participantIds"]),
        }

    async def test_member_updated_reloads_directory_and_retires_a_disabled_agent(self) -> None:
        # The reloaded bootstrap omits the disabled agent; the event payload
        # still describes it as an ordinary active member, because the wire
        # member shape has no status field to say otherwise.
        factory = FakeProcessFactory(
            directory_reload_specs(
                "150",
                [AGENT_USER, HUMAN_USER],
                [DM_SUMMARY, CHANNEL_SUMMARY, PEER_AGENT_DM_SUMMARY],
            )
        )
        adapter = self.new_adapter(factory)
        self.prepare_adapter(adapter)
        self.add_peer_agent(adapter)

        outcome = await adapter._accept_event(
            event("member.updated", "101", {"member": PEER_AGENT_USER})
        )

        self.assertEqual(outcome, "accepted")
        self.assertEqual(len(factory.calls), 2)
        # Upserting the payload would have re-asserted the very member the
        # event was emitted to retire.
        self.assertNotIn(PEER_AGENT_ID, adapter._members)
        self.assertEqual(sorted(adapter._members), sorted([AGENT_ID, USER_ID]))
        # _load_directory() re-pins the agent's own record, so the agent can
        # never delete itself even if the server omits it.
        self.assertEqual(adapter._members[AGENT_ID], dict(AGENT_USER))
        # The disabled agent stops resolving as a DM counterpart.
        self.assertEqual(
            (await adapter.get_chat_info(PEER_AGENT_DM_ID))["name"], "Direct message"
        )
        # The watch cursor advances from the event's own workspaceSequence;
        # the reload's bootstrap cursor ("150") is discarded, not assigned.
        self.assertEqual(adapter._cursor, "101")
        self.assertEqual(adapter._load_cursor(), "101")

    async def test_member_updated_payload_never_patches_the_directory(self) -> None:
        # The payload is advisory. Even a payload that disagrees with the
        # server must lose to the reloaded, authoritative directory.
        factory = FakeProcessFactory(directory_reload_specs("150"))
        adapter = self.new_adapter(factory)
        self.prepare_adapter(adapter)
        impostor = user(USER_ID, "impostor", "Impostor")

        outcome = await adapter._accept_event(event("member.updated", "101", {"member": impostor}))

        self.assertEqual(outcome, "accepted")
        self.assertEqual(adapter._members[USER_ID], dict(HUMAN_USER))
        self.assertEqual((await adapter.get_chat_info(DM_ID))["name"], "Morgan")

    async def test_disabled_agent_stops_resolving_as_a_message_author(self) -> None:
        factory = FakeProcessFactory(
            directory_reload_specs(
                "150",
                [AGENT_USER, HUMAN_USER],
                [DM_SUMMARY, CHANNEL_SUMMARY, PEER_AGENT_DM_SUMMARY],
            )
            # _dispatch_message retries the directory once when the author is
            # unresolved, in case a metadata update raced the message.
            + directory_reload_specs(
                "151",
                [AGENT_USER, HUMAN_USER],
                [DM_SUMMARY, CHANNEL_SUMMARY, PEER_AGENT_DM_SUMMARY],
            )
        )
        adapter = self.new_adapter(factory)
        self.prepare_adapter(adapter)
        self.add_peer_agent(adapter)

        await adapter._accept_event(event("member.updated", "101", {"member": PEER_AGENT_USER}))
        outcome = await adapter._accept_event(
            message_event("102", PEER_AGENT_DM_ID, PEER_AGENT_ID)
        )

        self.assertEqual(outcome, "accepted")
        self.assertEqual(len(factory.calls), 4)
        self.assertEqual(adapter.handled_events, [])
        self.assertEqual(adapter._cursor, "102")

    async def test_member_updated_with_invalid_payload_is_fatal_without_reload(self) -> None:
        factory = FakeProcessFactory([])
        adapter = self.new_adapter(factory)
        self.prepare_adapter(adapter)
        malformed = event("member.updated", "101", {"member": {"id": 7}})

        with self.assertRaises(adapter_module.CliFailure) as caught:
            await adapter._accept_event(malformed)

        self.assertEqual(caught.exception.code, "INVALID_MEMBER_EVENT")
        self.assertEqual(factory.calls, [])
        self.assertEqual(adapter._cursor, "100")

    async def test_membership_changed_directory_refresh_failure_is_retryable_and_skips_checkpoint(
        self,
    ) -> None:
        # channel.membership_changed reaches _load_directory() by the same
        # route as member.updated when the agent is added to a conversation
        # it has not cached, so it needs the same guard: a non-retryable
        # refresh failure escaping here would stop the supervisor for good.
        malformed_bootstrap = {
            "currentUser": principal(),
            "syncCursor": "150",
            "members": [AGENT_USER, HUMAN_USER],
            # "workspace" is missing on purpose.
        }
        factory = FakeProcessFactory(
            [
                ProcessSpec(
                    ("workspace", "bootstrap", "--json"), json_process(malformed_bootstrap)
                ),
                ProcessSpec(
                    ("conversations", "list", "--all", "--json"),
                    json_process(
                        {
                            "conversations": [DM_SUMMARY, CHANNEL_SUMMARY],
                            "nextCursor": None,
                            "hasMore": False,
                        }
                    ),
                ),
            ]
        )
        adapter = self.new_adapter(factory)
        self.prepare_adapter(adapter)

        with self.assertRaises(adapter_module.CliFailure) as caught:
            await adapter._accept_event(
                membership_changed_event("101", NEW_CHANNEL_ID, AGENT_ID, "added")
            )

        self.assertTrue(caught.exception.retryable)
        # Exit code 5 specifically: _watch_supervisor re-derives retryability
        # from the exit code, and only 5 survives that second pass.
        self.assertEqual(caught.exception.exit_code, 5)
        self.assertEqual(adapter._cursor, "100")
        self.assertEqual(adapter._load_cursor(), "100")

    async def test_member_updated_directory_refresh_failure_is_retryable_and_skips_checkpoint(
        self,
    ) -> None:
        # Before this diff the member.updated branch only patched an
        # in-memory dict and could never fail. _load_directory() classifies
        # a malformed bootstrap response as non-retryable
        # (INVALID_DIRECTORY_CONTRACT) -- correct for the connect()-time
        # caller, which should give up on a config problem, but not here:
        # unhandled, it would reach _watch_supervisor and permanently stop
        # the adapter over a refresh problem the CLI may answer differently
        # next time. _accept_event must re-raise it as retryable instead.
        malformed_bootstrap = {
            "currentUser": principal(),
            "syncCursor": "150",
            "members": [AGENT_USER, HUMAN_USER],
            # "workspace" is missing on purpose.
        }
        factory = FakeProcessFactory(
            [
                ProcessSpec(
                    ("workspace", "bootstrap", "--json"), json_process(malformed_bootstrap)
                ),
                ProcessSpec(
                    ("conversations", "list", "--all", "--json"),
                    json_process(
                        {
                            "conversations": [DM_SUMMARY, CHANNEL_SUMMARY],
                            "nextCursor": None,
                            "hasMore": False,
                        }
                    ),
                ),
            ]
        )
        adapter = self.new_adapter(factory)
        self.prepare_adapter(adapter)

        with self.assertRaises(adapter_module.CliFailure) as caught:
            await adapter._accept_event(
                event("member.updated", "101", {"member": PEER_AGENT_USER})
            )

        self.assertTrue(caught.exception.retryable)
        self.assertEqual(len(factory.calls), 2)
        # The event's own cursor must not be persisted -- an unrefreshed
        # directory has to be retried, not silently skipped.
        self.assertEqual(adapter._cursor, "100")
        self.assertEqual(adapter._load_cursor(), "100")

    async def test_membership_added_for_known_conversation_updates_cache_without_reload(
        self,
    ) -> None:
        adapter = self.new_adapter(FakeProcessFactory([]))
        self.prepare_adapter(adapter)

        outcome = await adapter._accept_event(
            membership_changed_event("101", CHANNEL_ID, SECOND_USER_ID, "added")
        )

        self.assertEqual(outcome, "accepted")
        self.assertEqual(adapter._cursor, "101")
        self.assertEqual(
            adapter._conversations[CHANNEL_ID]["participantIds"],
            [SECOND_USER_ID],
        )

    async def test_membership_removed_for_known_conversation_updates_cache_without_reload(
        self,
    ) -> None:
        adapter = self.new_adapter(FakeProcessFactory([]))
        self.prepare_adapter(adapter)

        outcome = await adapter._accept_event(
            membership_changed_event("101", DM_ID, USER_ID, "removed")
        )

        self.assertEqual(outcome, "accepted")
        self.assertEqual(adapter._cursor, "101")
        self.assertEqual(adapter._conversations[DM_ID]["participantIds"], [AGENT_ID])

    async def test_membership_updated_action_is_a_no_op_but_still_persists_cursor(
        self,
    ) -> None:
        adapter = self.new_adapter(FakeProcessFactory([]))
        self.prepare_adapter(adapter)
        original_participant_ids = list(adapter._conversations[DM_ID]["participantIds"])

        outcome = await adapter._accept_event(
            membership_changed_event("101", DM_ID, USER_ID, "updated")
        )

        self.assertEqual(outcome, "accepted")
        self.assertEqual(adapter._cursor, "101")
        self.assertEqual(
            adapter._conversations[DM_ID]["participantIds"], original_participant_ids
        )

    async def test_agent_added_to_new_channel_refreshes_directory(self) -> None:
        new_channel_summary = conversation(
            NEW_CHANNEL_ID,
            "channel",
            [AGENT_ID, SECOND_USER_ID],
            name="Incident Response",
            slug="incident-response",
            topic="Ops escalation",
        )
        factory = FakeProcessFactory(
            [
                ProcessSpec(("workspace", "bootstrap", "--json"), json_process(bootstrap("150"))),
                ProcessSpec(
                    ("conversations", "list", "--all", "--json"),
                    json_process(
                        {
                            "conversations": [DM_SUMMARY, CHANNEL_SUMMARY, new_channel_summary],
                            "nextCursor": None,
                            "hasMore": False,
                        }
                    ),
                ),
            ]
        )
        adapter = self.new_adapter(factory)
        self.prepare_adapter(adapter)

        outcome = await adapter._accept_event(
            membership_changed_event("101", NEW_CHANNEL_ID, AGENT_ID, "added")
        )

        self.assertEqual(outcome, "accepted")
        # The persisted cursor is the membership event's own workspace
        # sequence, not the bootstrap response's syncCursor.
        self.assertEqual(adapter._cursor, "101")
        self.assertEqual(len(factory.calls), 2)
        self.assertEqual(
            (await adapter.get_chat_info(NEW_CHANNEL_ID))["name"], "Incident Response"
        )

    async def test_agent_removed_from_channel_drops_cached_conversation_without_reload(
        self,
    ) -> None:
        adapter = self.new_adapter(FakeProcessFactory([]))
        self.prepare_adapter(adapter)

        outcome = await adapter._accept_event(
            membership_changed_event("101", DM_ID, AGENT_ID, "removed")
        )

        self.assertEqual(outcome, "accepted")
        self.assertEqual(adapter._cursor, "101")
        self.assertNotIn(DM_ID, adapter._conversations)
        fallback_info = await adapter.get_chat_info(DM_ID)
        self.assertEqual(fallback_info, {"id": DM_ID, "name": DM_ID, "type": "channel"})

    async def test_membership_added_for_unknown_conversation_refreshes_directory(self) -> None:
        factory = FakeProcessFactory(
            [
                ProcessSpec(("workspace", "bootstrap", "--json"), json_process(bootstrap("100"))),
                ProcessSpec(
                    ("conversations", "list", "--all", "--json"),
                    json_process(
                        {
                            "conversations": [DM_SUMMARY, CHANNEL_SUMMARY],
                            "nextCursor": None,
                            "hasMore": False,
                        }
                    ),
                ),
            ]
        )
        adapter = self.new_adapter(factory)
        self.prepare_adapter(adapter)

        outcome = await adapter._accept_event(
            membership_changed_event("101", UNKNOWN_CHANNEL_ID, SECOND_USER_ID, "added")
        )

        self.assertEqual(outcome, "accepted")
        self.assertEqual(adapter._cursor, "101")
        self.assertEqual(len(factory.calls), 2)

    async def test_membership_removed_for_unknown_conversation_is_a_no_op(self) -> None:
        adapter = self.new_adapter(FakeProcessFactory([]))
        self.prepare_adapter(adapter)

        outcome = await adapter._accept_event(
            membership_changed_event("101", UNKNOWN_CHANNEL_ID, SECOND_USER_ID, "removed")
        )

        self.assertEqual(outcome, "accepted")
        self.assertEqual(adapter._cursor, "101")
        self.assertNotIn(UNKNOWN_CHANNEL_ID, adapter._conversations)

    async def test_membership_changed_with_invalid_payload_is_fatal(self) -> None:
        adapter = self.new_adapter(FakeProcessFactory([]))
        self.prepare_adapter(adapter)
        malformed = event(
            "channel.membership_changed",
            "101",
            {"memberId": USER_ID},
            conversation_id=CHANNEL_ID,
        )

        with self.assertRaises(adapter_module.CliFailure) as caught:
            await adapter._accept_event(malformed)
        self.assertEqual(caught.exception.code, "INVALID_MEMBERSHIP_EVENT")
        self.assertEqual(adapter._cursor, "100")

    async def test_unrecognized_event_type_is_ignored_without_advancing_cursor(self) -> None:
        adapter = self.new_adapter(FakeProcessFactory([]))
        self.prepare_adapter(adapter)
        unknown = event("reaction.added", "101", {"reaction": "thumbsup"})

        outcome = await adapter._accept_event(unknown)

        self.assertEqual(outcome, "ignored")
        self.assertEqual(adapter._cursor, "100")

    async def test_unrecognized_event_with_null_workspace_id_is_ignored_not_fatal(self) -> None:
        # system.error has a nullable workspaceId in the contract. Unknown
        # types must be ignored before the workspaceId check runs, or this
        # would incorrectly raise WORKSPACE_MISMATCH instead of being ignored.
        adapter = self.new_adapter(FakeProcessFactory([]))
        self.prepare_adapter(adapter)
        unknown = event("system.error", "101", {"message": "boom"})
        unknown["workspaceId"] = None

        outcome = await adapter._accept_event(unknown)

        self.assertEqual(outcome, "ignored")
        self.assertEqual(adapter._cursor, "100")

    async def test_watch_consumer_stays_connected_across_unrecognized_event(self) -> None:
        adapter = self.new_adapter(FakeProcessFactory([]))
        self.prepare_adapter(adapter)
        unknown = event("reaction.added", "101", {"reaction": "thumbsup"})
        recognized = message_event("102", DM_ID, USER_ID, body="after unknown event")
        process = FakeWatchProcess(
            [
                json.dumps(unknown).encode("utf-8") + b"\n",
                json.dumps(recognized).encode("utf-8") + b"\n",
            ]
        )

        return_code, needs_resync, saw_event, _stderr = await asyncio.wait_for(
            adapter._consume_watch(process), timeout=0.5
        )

        self.assertEqual(return_code, 0)
        self.assertFalse(needs_resync)
        self.assertTrue(saw_event)
        self.assertEqual(adapter._cursor, "102")

    async def test_persisted_cursor_is_used_after_restart(self) -> None:
        first = self.new_adapter(FakeProcessFactory([]))
        self.prepare_adapter(first)
        await first._accept_event(message_event("101", DM_ID, USER_ID))

        watch = FakeWatchProcess(blocking=True)
        factory = FakeProcessFactory(
            startup_specs("500") + [ProcessSpec(("watch", "--json", "--after", "101"), watch)]
        )
        restarted = self.new_adapter(factory)
        self.assertTrue(await restarted.connect())
        self.assertEqual(factory.calls[-1]["args"], ("watch", "--json", "--after", "101"))
        await restarted.disconnect()

    async def test_equal_cursor_resync_is_not_suppressed_and_consumer_terminates_child(self) -> None:
        adapter = self.new_adapter(FakeProcessFactory([]))
        self.prepare_adapter(adapter)
        resync = event("system.resync_required", "100", {"reason": "cursor_expired"})
        process = FakeWatchProcess(
            [json.dumps(resync).encode("utf-8") + b"\n"],
            blocking=True,
        )

        result = await asyncio.wait_for(adapter._consume_watch(process), timeout=0.5)
        self.assertTrue(result[1])
        self.assertTrue(process.terminated)
        self.assertEqual(adapter._cursor, "100")

    async def test_invalid_ndjson_terminates_before_stderr_drain(self) -> None:
        adapter = self.new_adapter(FakeProcessFactory([]))
        self.prepare_adapter(adapter)
        process = FakeWatchProcess([b"not-json\n"], blocking=True)

        with self.assertRaises(adapter_module.CliFailure):
            await asyncio.wait_for(adapter._consume_watch(process), timeout=0.5)
        self.assertTrue(process.terminated)

    async def test_resync_reloads_directory_and_restarts_from_bootstrap_cursor(self) -> None:
        resync = event("system.resync_required", "100", {"reason": "server_reset"})
        first_watch = FakeWatchProcess(
            [json.dumps(resync).encode("utf-8") + b"\n"],
            blocking=True,
        )
        second_watch = FakeWatchProcess(blocking=True)
        refresh_specs = [
            ProcessSpec(("workspace", "bootstrap", "--json"), json_process(bootstrap("200"))),
            ProcessSpec(
                ("conversations", "list", "--all", "--json"),
                json_process(
                    {
                        "conversations": [DM_SUMMARY, CHANNEL_SUMMARY],
                        "nextCursor": None,
                        "hasMore": False,
                    }
                ),
            ),
            ProcessSpec(("watch", "--json", "--after", "200"), second_watch),
        ]
        factory = FakeProcessFactory(refresh_specs)
        adapter = self.new_adapter(factory)
        self.prepare_adapter(adapter)
        adapter._backoff_base = 0
        adapter._backoff_max = 0

        task = asyncio.create_task(adapter._watch_supervisor(first_watch))
        for _ in range(50):
            if factory.calls and factory.calls[-1]["args"] == (
                "watch",
                "--json",
                "--after",
                "200",
            ):
                break
            await asyncio.sleep(0)
        self.assertEqual(adapter._cursor, "200")
        self.assertEqual(factory.calls[-1]["args"], ("watch", "--json", "--after", "200"))
        adapter._stop_event.set()
        await adapter._terminate_process(second_watch)
        await asyncio.wait_for(task, timeout=0.5)

    async def test_process_crash_and_retryable_respawn_failure_stay_supervised(self) -> None:
        first_watch = FakeWatchProcess(returncode=1)
        recovered_watch = FakeWatchProcess(blocking=True)
        factory = FakeProcessFactory(
            [
                ProcessSpec(
                    ("watch", "--json", "--after", "100"),
                    OSError("transient spawn failure"),
                ),
                ProcessSpec(("watch", "--json", "--after", "100"), recovered_watch),
            ]
        )
        adapter = self.new_adapter(factory)
        self.prepare_adapter(adapter)
        adapter._backoff_base = 0
        adapter._backoff_max = 0

        task = asyncio.create_task(adapter._watch_supervisor(first_watch))
        for _ in range(50):
            if len(factory.calls) == 2:
                break
            await asyncio.sleep(0)
        self.assertEqual(len(factory.calls), 2)
        self.assertFalse(task.done())
        adapter._stop_event.set()
        await adapter._terminate_process(recovered_watch)
        await asyncio.wait_for(task, timeout=0.5)

    async def test_member_updated_directory_refresh_failure_does_not_stop_the_supervisor(
        self,
    ) -> None:
        # Regression test for the member.updated branch of _accept_event: a
        # _load_directory() failure on that path used to propagate as
        # whatever CliFailure _load_directory() itself raised (often
        # non-retryable), which _watch_supervisor treats as fatal and never
        # recovers from. The adapter must instead stay online, reconnect,
        # and retry -- and must not have checkpointed the failed event.
        malformed_bootstrap = {
            "currentUser": principal(),
            "syncCursor": "150",
            "members": [AGENT_USER, HUMAN_USER],
            # "workspace" is missing on purpose.
        }
        member_updated = event("member.updated", "101", {"member": PEER_AGENT_USER})
        first_watch = FakeWatchProcess(
            [json.dumps(member_updated).encode("utf-8") + b"\n"],
            blocking=True,
        )
        second_watch = FakeWatchProcess(blocking=True)
        factory = FakeProcessFactory(
            [
                ProcessSpec(
                    ("workspace", "bootstrap", "--json"), json_process(malformed_bootstrap)
                ),
                ProcessSpec(
                    ("conversations", "list", "--all", "--json"),
                    json_process(
                        {
                            "conversations": [DM_SUMMARY, CHANNEL_SUMMARY],
                            "nextCursor": None,
                            "hasMore": False,
                        }
                    ),
                ),
                ProcessSpec(("watch", "--json", "--after", "100"), second_watch),
            ]
        )
        adapter = self.new_adapter(factory)
        self.prepare_adapter(adapter)
        adapter._backoff_base = 0
        adapter._backoff_max = 0

        task = asyncio.create_task(adapter._watch_supervisor(first_watch))
        for _ in range(50):
            if len(factory.calls) == 3:
                break
            await asyncio.sleep(0)
        self.assertEqual(len(factory.calls), 3)
        self.assertEqual(factory.calls[-1]["args"], ("watch", "--json", "--after", "100"))
        # The supervisor reconnected instead of calling _supervisor_fatal.
        self.assertIsNone(adapter.fatal_error)
        self.assertFalse(task.done())
        # The failed refresh must not have advanced the checkpoint: the CLI
        # replays from "100" on reconnect, so the same member.updated event
        # is redelivered and the refresh is retried, not silently skipped.
        self.assertEqual(adapter._cursor, "100")

        adapter._stop_event.set()
        await adapter._terminate_process(second_watch)
        await asyncio.wait_for(task, timeout=0.5)

    async def test_backoff_delay_has_a_floor_and_does_not_collapse_to_zero(self) -> None:
        adapter = self.new_adapter(FakeProcessFactory([]))
        adapter._backoff_base = 1.0
        adapter._backoff_max = 30.0
        # Setting the stop event first makes the internal wait_for resolve
        # immediately regardless of the timeout, so the test does not
        # actually sleep for the computed delay.
        adapter._stop_event.set()
        real_wait_for = asyncio.wait_for
        captured: dict[str, float] = {}

        async def spy_wait_for(awaitable: Any, timeout: float) -> Any:
            captured["timeout"] = timeout
            return await real_wait_for(awaitable, timeout)

        with patch.object(adapter_module.random, "random", return_value=0.0), patch.object(
            adapter_module.asyncio, "wait_for", spy_wait_for
        ):
            await adapter._backoff(3, None)

        # attempt=3 -> cap = min(30, 1.0 * 2**3) = 8.0. Even with the
        # smallest possible jitter draw (random() == 0.0), the delay must
        # floor at the full backoff step instead of collapsing toward zero.
        self.assertAlmostEqual(captured["timeout"], 8.0)

    async def test_backoff_floor_survives_a_zero_retry_after(self) -> None:
        # Retry-After: 0, or an HTTP-date already elapsed when the CLI parsed it, reaches
        # the adapter as retry_after == 0.0. A requested delay extends the backoff step,
        # it never erases it -- otherwise the supervisor respawns the watch subprocess in
        # a tight loop against the endpoint that just asked it to back off.
        adapter = self.new_adapter(FakeProcessFactory([]))
        adapter._backoff_base = 1.0
        adapter._backoff_max = 30.0
        adapter._stop_event.set()
        real_wait_for = asyncio.wait_for
        captured: dict[str, float] = {}

        async def spy_wait_for(awaitable: Any, timeout: float) -> Any:
            captured["timeout"] = timeout
            return await real_wait_for(awaitable, timeout)

        with patch.object(adapter_module.random, "random", return_value=0.0), patch.object(
            adapter_module.asyncio, "wait_for", spy_wait_for
        ):
            await adapter._backoff(3, 0.0)

        self.assertAlmostEqual(captured["timeout"], 8.0)

    async def test_backoff_honors_a_retry_after_longer_than_the_step(self) -> None:
        adapter = self.new_adapter(FakeProcessFactory([]))
        adapter._backoff_base = 1.0
        adapter._backoff_max = 30.0
        adapter._stop_event.set()
        real_wait_for = asyncio.wait_for
        captured: dict[str, float] = {}

        async def spy_wait_for(awaitable: Any, timeout: float) -> Any:
            captured["timeout"] = timeout
            return await real_wait_for(awaitable, timeout)

        with patch.object(adapter_module.random, "random", return_value=0.0), patch.object(
            adapter_module.asyncio, "wait_for", spy_wait_for
        ):
            await adapter._backoff(3, 100.0)

        # attempt=3 -> cap 8.0, so the server's longer request wins -- but it stays capped
        # at _backoff_max, so a hostile Retry-After cannot park the adapter indefinitely.
        self.assertAlmostEqual(captured["timeout"], 30.0)

    async def test_send_uses_private_stdin_and_classifies_retryable_failure(self) -> None:
        success_process = json_process({"message": {"id": MESSAGE_ID}, "syncCursor": "101"})
        rate_error = {
            "error": {
                "code": "RATE_LIMITED",
                "message": "slow down",
                "httpStatus": 429,
                "requestId": "request-1",
                "retryable": True,
                "retryAfterMs": 2500,
            }
        }
        failure_process = FakeProcess(
            stderr=json.dumps(rate_error).encode("utf-8"),
            returncode=5,
        )
        factory = FakeProcessFactory(
            [
                ProcessSpec(("messages", "send", DM_ID, "--json"), success_process),
                ProcessSpec(("messages", "send", DM_ID, "--json"), failure_process),
            ]
        )
        adapter = self.new_adapter(factory)
        adapter._api_origin = ORIGIN

        sent = await adapter.send(DM_ID, "body from stdin")
        failed = await adapter.send(DM_ID, "retry me")
        too_long = await adapter.send(DM_ID, "😀" * 2001)

        self.assertTrue(sent.success)
        self.assertEqual(sent.message_id, MESSAGE_ID)
        self.assertEqual(success_process.input, b"body from stdin")
        self.assertNotIn("body from stdin", factory.calls[0]["args"])
        self.assertFalse(failed.success)
        self.assertTrue(failed.retryable)
        self.assertEqual(failed.retry_after, 2.5)
        self.assertEqual(failed.error_kind, "rate_limited")
        self.assertFalse(too_long.success)
        self.assertEqual(too_long.error_kind, "too_long")

    async def test_lock_conflict_stops_before_watch(self) -> None:
        factory = FakeProcessFactory(startup_specs())
        adapter = self.new_adapter(
            factory,
            config=FakePlatformConfig(extra={"lock_success": False}),
        )

        self.assertFalse(await adapter.connect())
        self.assertEqual(len(factory.calls), 3)
        self.assertIsNone(adapter._watch_task)

    async def test_standalone_cron_sender_uses_cli_stdin(self) -> None:
        captured: dict[str, Any] = {}

        async def fake_run(
            cli: str,
            args: list[str],
            **kwargs: Any,
        ) -> dict[str, Any]:
            captured.update({"cli": cli, "args": args, **kwargs})
            return {"message": {"id": MESSAGE_ID}, "syncCursor": "101"}

        with patch.object(adapter_module, "_run_cli_json", side_effect=fake_run):
            result = await adapter_module._standalone_send(
                FakePlatformConfig(),
                DM_ID,
                "cron body",
            )

        self.assertEqual(result, {"success": True, "message_id": MESSAGE_ID})
        self.assertEqual(captured["args"], ["messages", "send", DM_ID, "--json"])
        self.assertEqual(captured["stdin_text"], "cron body")
        self.assertNotIn("cron body", captured["args"])

    def test_registration_uses_hermes_platform_auth_cron_and_limits(self) -> None:
        class Context:
            kwargs: dict[str, Any]

            def register_platform(self, **kwargs: Any) -> None:
                self.kwargs = kwargs

        context = Context()
        adapter_module.register(context)

        self.assertEqual(context.kwargs["name"], "hype_comms")
        self.assertEqual(context.kwargs["allowed_users_env"], "HYPE_COMMS_ALLOWED_USERS")
        self.assertEqual(context.kwargs["allow_all_env"], "HYPE_COMMS_ALLOW_ALL_USERS")
        self.assertEqual(context.kwargs["max_message_length"], 4000)
        self.assertEqual(
            context.kwargs["cron_deliver_env_var"],
            "HYPE_COMMS_HOME_CONVERSATION",
        )
        self.assertTrue(callable(context.kwargs["standalone_sender_fn"]))


if __name__ == "__main__":
    unittest.main()
