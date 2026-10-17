"""Maps a system id (Linux username, or a Docker-inferred owner) to the display
name shown in the UI. The table lives in config.json under "user_map" and is
read live, so edits take effect without a restart."""
from config import get_config


def get_user_map() -> dict:
    um = get_config().get("user_map")
    return um if isinstance(um, dict) else {}


def display_name(sys_id: str) -> str:
    return get_user_map().get(sys_id, sys_id)
