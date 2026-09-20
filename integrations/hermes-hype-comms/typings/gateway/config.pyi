from typing import Any

class Platform:
    value: str
    def __new__(cls, value: str) -> Platform: ...

class PlatformConfig:
    extra: dict[str, Any]
