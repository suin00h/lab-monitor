"""Central configuration.

Everything an operator needs to tune lives in ONE file: config.json (copy it
from config.example.json). It is read live — editing user_map, remote_hosts, the
disk roots or the site title takes effect on the next poll with no restart. Only
the poll *cadence* (intervals) and the listen port are read once at startup, so
changing those needs a restart.

    cp config.example.json config.json   # then edit
    # or point elsewhere:  LAB_MONITOR_CONFIG=/etc/lab-monitor.json
"""
import os
import json
import socket
import threading
from pathlib import Path

BASE_DIR = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = BASE_DIR / "data"

CONFIG_FILE = Path(os.environ.get("LAB_MONITOR_CONFIG", BASE_DIR / "config.json"))
_EXAMPLE_FILE = BASE_DIR / "config.example.json"

# Runtime data that the app itself writes (not user-edited config).
GPU_NOTES_FILE = DATA_DIR / "gpu_notes.json"  # per-process comments, keyed host:gpu:pid

_DEFAULTS = {
    "site_title": "Lab Monitor",
    "host_name": socket.gethostname(),
    "port": 8000,
    # id -> display name. The id is the Linux username (or, for Docker jobs, the
    # name inferred from the container). Anything unmapped shows the raw id.
    "user_map": {},
    # other hosts this instance polls and re-serves behind its own URL.
    #   [{"id": "node2", "name": "Node 2", "base_url": "http://10.0.0.5:8000"}]
    "remote_hosts": [],
    "disk": {
        # top-level size breakdown is shown for these roots
        "breakdown_roots": ["/data", "/home"],
        # ...but only these may be *drilled into* from the browser (privacy guard)
        "drill_roots": ["/data"],
    },
    # poll cadence (seconds) — read once at startup; restart to change
    "intervals": {
        "gpu": 3,
        "memory_pss": 20,
        "subdir": 1800,
        "remote_poll": 5,
        "remote_stale_after": 20,
        "remote_fetch_timeout": 4,
    },
}

_lock = threading.Lock()
_cache: dict | None = None
_mtime: float | None = None


def _read(path: Path) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def get_config() -> dict:
    """Return the merged config, re-reading the file when it changes on disk.

    config.json wins; config.example.json is the fallback so a fresh checkout
    runs before anyone writes config.json; built-in _DEFAULTS backstop both.
    """
    global _cache, _mtime
    src = CONFIG_FILE if CONFIG_FILE.exists() else _EXAMPLE_FILE
    try:
        m = src.stat().st_mtime
    except FileNotFoundError:
        m = None
    if _cache is not None and m == _mtime:
        return _cache
    with _lock:
        if _cache is not None and m == _mtime:
            return _cache
        raw = _read(src) if m is not None else {}
        merged = {**_DEFAULTS, **raw}
        merged["disk"] = {**_DEFAULTS["disk"], **(raw.get("disk") or {})}
        merged["intervals"] = {**_DEFAULTS["intervals"], **(raw.get("intervals") or {})}
        _cache, _mtime = merged, m
        return merged


# ── startup-time constants (restart to change) ──────────────────────────────
LOCAL_HOST_ID = "local"
_iv = get_config()["intervals"]
GPU_INTERVAL = _iv["gpu"]
MEM_PSS_INTERVAL = _iv["memory_pss"]
SUBDIR_INTERVAL = _iv["subdir"]
REMOTE_POLL_INTERVAL = _iv["remote_poll"]
REMOTE_STALE_AFTER = _iv["remote_stale_after"]
REMOTE_FETCH_TIMEOUT = _iv["remote_fetch_timeout"]
PORT = int(get_config()["port"])
