from collections.abc import Awaitable, Callable
from typing import Any
from gateway.config import PlatformConfig
from gateway.platforms.base import BasePlatformAdapter

# Consumed register_platform arguments from the pinned PluginContext/PlatformEntry.
class PluginContext:
    def register_platform(self, *, name: str, label: str,
                          adapter_factory: Callable[[PlatformConfig], BasePlatformAdapter],
                          check_fn: Callable[[], bool],
                          validate_config: Callable[[PlatformConfig], bool],
                          is_connected: Callable[[PlatformConfig], bool],
                          required_env: list[str], install_hint: str,
                          env_enablement_fn: Callable[[], dict[str, Any] | None],
                          cron_deliver_env_var: str,
                          standalone_sender_fn: Callable[..., Awaitable[dict[str, Any]]],
                          allowed_users_env: str, allow_all_env: str,
                          max_message_length: int, emoji: str, pii_safe: bool,
                          allow_update_command: bool, platform_hint: str) -> None: ...
