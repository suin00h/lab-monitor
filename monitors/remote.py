"""Polls remote Lab Monitor instances and caches their metrics.

A background thread (see monitors/scheduler.py) calls poll_once() on an
interval. Each remote host's /api/gpu, /api/memory and /api/disk are fetched
and stored; the API layer serves the cached copy so a slow or offline remote
never blocks the dashboard. Remotes are discovered live from hosts.remote_hosts().
"""
import json
import time
import threading
import urllib.request

import hosts
from config import REMOTE_STALE_AFTER, REMOTE_FETCH_TIMEOUT

_lock = threading.Lock()
# {host_id: {"gpu":..., "memory":..., "disk":..., "last_ok": ts|None, "error": str|None}}
_store: dict = {}

# metrics polled on the interval (disk drill-down is proxied on demand instead)
POLL_METRICS = ("gpu", "memory", "disk", "cpu")


def _fetch_json(base_url: str, path: str):
    url = f"{base_url}{path}"
    req = urllib.request.Request(url, headers={"User-Agent": "lab-monitor-poller"})
    with urllib.request.urlopen(req, timeout=REMOTE_FETCH_TIMEOUT) as r:
        return json.loads(r.read().decode())


def poll_once():
    """Fetch every remote host's metrics once; update the cache in place."""
    for h in hosts.remote_hosts():
        data, err = {}, None
        for m in POLL_METRICS:
            try:
                data[m] = _fetch_json(h["base_url"], f"/api/{m}")
            except Exception as e:  # network error, timeout, bad JSON, etc.
                err = f"{type(e).__name__}: {e}"
                break
        with _lock:
            entry = _store.setdefault(h["id"], {})
            if err is None:
                entry.update(data)
                entry["last_ok"] = time.time()
                entry["error"] = None
            else:
                # keep the last good snapshot; just record the error
                entry["error"] = err


def get_metric(host_id: str, metric: str):
    """Return (data, last_ok_ts) for a cached remote metric, or (None, None)."""
    with _lock:
        entry = _store.get(host_id)
        if not entry:
            return None, None
        return entry.get(metric), entry.get("last_ok")


def freshness(host_id: str) -> dict:
    """Online/stale status for a remote host, for the UI selector."""
    with _lock:
        entry = _store.get(host_id) or {}
        last_ok = entry.get("last_ok")
        error = entry.get("error")
    if not last_ok:
        return {"online": False, "last_ok": None, "age": None, "error": error}
    age = time.time() - last_ok
    return {"online": age <= REMOTE_STALE_AFTER, "last_ok": last_ok, "age": age, "error": error}


def proxy_json(host_id: str, path: str):
    """On-demand fetch of an arbitrary remote path (e.g. disk drill-down)."""
    h = hosts.find_remote(host_id)
    if not h:
        return None
    return _fetch_json(h["base_url"], path)
