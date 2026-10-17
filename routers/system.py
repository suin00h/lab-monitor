import json
import time
import secrets
import urllib.parse
import urllib.error

from fastapi import APIRouter, HTTPException, Query, Body

import hosts
from config import GPU_NOTES_FILE, get_config
from monitors import gpu, memory, disk, remote, docker_status, cpu

router = APIRouter()


@router.get("/api/config")
def config_api():
    """Public UI config — just the branding the frontend needs to render.
    (Kept intentionally minimal; never expose the full server config here.)"""
    return {"site_title": get_config()["site_title"]}


@router.get("/api/hosts")
def hosts_api():
    """List all hosts (local + remotes) with freshness, for the UI selector."""
    out = [{"id": hosts.local_host()["id"], "name": hosts.local_host()["name"],
            "local": True, "online": True}]
    for h in hosts.remote_hosts():
        out.append({"id": h["id"], "name": h["name"], "local": False,
                    **remote.freshness(h["id"])})
    return {"hosts": out}


def _remote_metric(host: str, metric: str):
    data, _ = remote.get_metric(host, metric)
    if data is None:
        raise HTTPException(503, f"No {metric} data cached for '{host}' yet.")
    return data


@router.get("/api/gpu")
def gpu_api(host: str = Query("")):
    if hosts.is_local(host):
        return gpu.get_cache()
    return _remote_metric(host, "gpu")


# ── per-process GPU comment feed ───────────────────────────────────────────
# A short comment feed a user can pin to a GPU process ("done in ~1h"), like a
# thread. Shared (stored centrally on the aggregator), keyed "host:gpu:pid" so
# remote-host GPUs are covered too; the UI only shows feeds whose PID is live.
# Each comment: {id, author, text, ts}. author is a per-browser anonymous id
# (localStorage) → the UI derives a fun icon from it.
def _load_gpu_notes():
    try:
        with open(GPU_NOTES_FILE) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def _save_gpu_notes(d):
    GPU_NOTES_FILE.parent.mkdir(exist_ok=True)
    with open(GPU_NOTES_FILE, "w") as f:
        json.dump(d, f, ensure_ascii=False)


def _as_feed(v):
    """Coerce any legacy single-note value into the comment-list shape."""
    if isinstance(v, list):
        return v
    if isinstance(v, dict) and v.get("text"):
        return [{"id": "legacy", "author": "anon", "text": v["text"], "ts": v.get("ts", 0)}]
    return []


@router.get("/api/gpu_notes")
def gpu_notes_get():
    return {k: _as_feed(v) for k, v in _load_gpu_notes().items()}


@router.post("/api/gpu_notes")
def gpu_notes_set(body: dict = Body(...)):
    gpu_id = str(body.get("gpu", "")).strip()
    pid = str(body.get("pid", "")).strip()
    if not gpu_id or not pid:
        raise HTTPException(400, "gpu and pid are required")
    host = str(body.get("host") or "local").strip()
    author = str(body.get("author") or "anon")[:40]
    key = f"{host}:{gpu_id}:{pid}"
    notes = _load_gpu_notes()
    feed = _as_feed(notes.get(key))
    if body.get("action") == "delete":
        cid = str(body.get("id", ""))
        # anyone can delete any comment — a shared internal tool, and author ids are
        # per-browser (clearing the cache would otherwise orphan a comment forever).
        feed = [c for c in feed if c.get("id") != cid]
    else:
        text = (body.get("text") or "").strip()[:200]
        if text:
            feed.append({
                "id": f"{int(time.time() * 1000)}-{secrets.token_hex(3)}",
                "author": author, "text": text, "ts": int(time.time()),
            })
    if feed:
        notes[key] = feed
    else:
        notes.pop(key, None)
    _save_gpu_notes(notes)
    return {"comments": feed}


@router.get("/api/memory")
def mem_api(host: str = Query("")):
    if hosts.is_local(host):
        return memory.get_cache()
    return _remote_metric(host, "memory")


@router.get("/api/cpu")
def cpu_api(host: str = Query("")):
    if hosts.is_local(host):
        return cpu.get_cache()
    return _remote_metric(host, "cpu")


@router.get("/api/disk")
def disk_api(host: str = Query("")):
    if hosts.is_local(host):
        return disk.get_disk_data()
    return _remote_metric(host, "disk")


@router.get("/api/docker")
def docker_api(host: str = Query("")):
    if hosts.is_local(host):
        return docker_status.get_docker_data()
    # Remote: fetch on demand (not on the poll loop — docker ps/images is heavy).
    # On any remote failure, return the docker "unavailable" shape (HTTP 200) with
    # a specific reason, so the Docker tab shows an accurate notice instead of the
    # generic offline card — an online host whose docker view just isn't reachable
    # (e.g. its monitor is too old to serve /api/docker) is NOT offline.
    if not hosts.find_remote(host):
        return {"available": False, "error": f"Unknown host '{host}'."}
    try:
        return remote.proxy_json(host, "/api/docker")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {"available": False,
                    "error": f"'{host}' is online, but its monitor is too old to serve the Docker view — update its code and restart."}
        return {"available": False, "error": f"'{host}' returned HTTP {e.code}."}
    except Exception:
        return {"available": False, "error": f"Could not reach '{host}'."}


@router.get("/api/disk/dir")
def disk_dir_api(path: str = Query(...), host: str = Query("")):
    if hosts.is_local(host):
        try:
            return {"path": path, "entries": disk.list_dir(path)}
        except PermissionError:
            raise HTTPException(403, "Directory browsing is restricted to /data.")
        except FileNotFoundError:
            raise HTTPException(404, "Directory not found.")
    # remote: proxy the drill-down to the owning host on demand
    if not hosts.find_remote(host):
        raise HTTPException(404, "Unknown host.")
    try:
        return remote.proxy_json(host, "/api/disk/dir?path=" + urllib.parse.quote(path))
    except urllib.error.HTTPError as e:  # forward the remote's own status
        raise HTTPException(e.code, "Remote host returned an error.")
    except Exception:
        raise HTTPException(502, f"Could not reach '{host}'.")
