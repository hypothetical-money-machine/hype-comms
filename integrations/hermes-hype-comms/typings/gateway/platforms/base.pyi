# Used API of NousResearch/hermes-agent f34a69b1cd7c5a6f73c2f7573634be07f666fc60.
# These stubs are verification inputs, never imported by the runtime plugin.
from collections.abc import Callable
from datetime import datetime
from typing import Any, ClassVar
from gateway.config import Platform, PlatformConfig

class MessageType:
    TEXT: ClassVar[MessageType]

class MessageSource:
    platform: Platform
    chat_id: str
    chat_name: str
    chat_type: str
    user_id: str
    user_name: str
    thread_id: str | None
    scope_id: str | None
    message_id: str | None

class MessageEvent:
    text: str
    source: MessageSource
    message_id: str | None
    metadata: dict[str, Any]
    channel_prompt: str | None
    def __init__(self, *, text: str, message_type: MessageType, source: MessageSource,
                 raw_message: object = ..., message_id: str | None = ...,
                 timestamp: datetime | None = ..., metadata: dict[str, Any] = ...,
                 channel_prompt: str | None = ...) -> None: ...

class SendResult:
    success: bool
    message_id: str | None
    error: str | None
    raw_response: object
    retryable: bool
    retry_after: float | None
    error_kind: str | None
    def __init__(self, *, success: bool, message_id: str | None = ..., error: str | None = ...,
                 raw_response: object = ..., retryable: bool = ..., retry_after: float | None = ...,
                 continuation_message_ids: tuple[str, ...] = ..., error_kind: str | None = ...) -> None: ...

class BasePlatformAdapter:
    config: PlatformConfig
    platform: Platform
    SUPPORTS_MESSAGE_EDITING: ClassVar[bool]
    def __init__(self, config: PlatformConfig, platform: Platform) -> None: ...
    @property
    def message_len_fn(self) -> Callable[[str], int]: ...
    def _acquire_platform_lock(self, scope: str, identity: str, description: str) -> bool: ...
    def _release_platform_lock(self) -> None: ...
    def _mark_connected(self) -> None: ...
    def _mark_disconnected(self) -> None: ...
    def _set_fatal_error(self, code: str, message: str, retryable: bool = ...) -> None: ...
    async def _notify_fatal_error(self) -> None: ...
    def build_source(self, *, chat_id: str, chat_name: str, chat_type: str, user_id: str,
                     user_name: str, thread_id: str | None = ..., chat_topic: str | None = ...,
                     scope_id: str | None = ..., message_id: str | None = ...) -> MessageSource: ...
    async def handle_message(self, event: MessageEvent) -> None: ...
    async def send(self, chat_id: str, content: str, reply_to: str | None = ...,
                   metadata: dict[str, Any] | None = ...) -> SendResult: ...
