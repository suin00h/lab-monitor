"""Docker images + containers for the dashboard (on-demand, not polled).

Two lean lists, stripped of the noise the user doesn't care about:
  - images:     repository:tag, size, created — the storage-facing view
  - containers: name, image, state, status, created — `docker ps -a` minus the
                COMMAND column.
The docker CLI is shelled out (the service runs as root, so the socket is
reachable). If docker is missing or the daemon is down, {"available": false} is
returned and the UI shows a friendly note instead of erroring. Not on the poll
loop — `docker images/ps` is heavy, so it's fetched only when the tab is open.
"""
import re
import json
import subprocess

# docker prints human sizes ("1.2GB", "345MB", "0B"); parse to bytes so the UI
# can sort largest-first and draw a relative bar. Base doesn't matter for
# ordering as long as it's consistent, but map SI vs binary units correctly.
_SIZE_RE = re.compile(r'([\d.]+)\s*([KMGTP]?i?B|B)', re.I)
_UNIT = {"B": 1, "KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12, "PB": 1e15,
         "KIB": 1024, "MIB": 1024**2, "GIB": 1024**3, "TIB": 1024**4, "PIB": 1024**5}


def _size_bytes(s):
    if not s:
        return 0
    m = _SIZE_RE.search(s)
    if not m:
        return 0
    try:
        return int(float(m.group(1)) * _UNIT.get(m.group(2).upper(), 1))
    except ValueError:
        return 0


# `docker ps` with `{{json .}}` serializes the .Size field, which forces docker
# to `du` every container's writable layer (~seconds). We don't show container
# size, so request only the fields we need via an explicit per-field template —
# that skips the size computation entirely and returns instantly.
PS_FMT = ('{{json .Names}}\t{{json .Image}}\t{{json .State}}'
          '\t{{json .Status}}\t{{json .RunningFor}}\t{{json .Ports}}')
_PS_KEYS = ["Names", "Image", "State", "Status", "RunningFor", "Ports"]


def _docker_json(args, fmt="{{json .}}"):
    """Run a docker command that emits one JSON object per line; return a list
    of dicts. Raises on any failure so the caller can flag docker unavailable."""
    r = subprocess.run(["docker", *args, "--format", fmt],
                       capture_output=True, text=True, timeout=8)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or "docker command failed")
    rows = []
    for ln in r.stdout.splitlines():
        ln = ln.strip()
        if ln:
            try:
                rows.append(json.loads(ln))
            except json.JSONDecodeError:
                pass
    return rows


def _docker_ps():
    """`docker ps -a` via the lean PS_FMT (tab-separated json values per line)."""
    r = subprocess.run(["docker", "ps", "-a", "--format", PS_FMT],
                       capture_output=True, text=True, timeout=8)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or "docker ps failed")
    rows = []
    for ln in r.stdout.splitlines():
        if not ln.strip():
            continue
        parts = ln.split("\t")
        if len(parts) != len(_PS_KEYS):
            continue
        try:
            rows.append({k: json.loads(v) for k, v in zip(_PS_KEYS, parts)})
        except json.JSONDecodeError:
            pass
    return rows


def _state_of(row):
    # modern docker (20.10+) reports State in json; fall back to parsing Status
    state = (row.get("State") or "").lower()
    if state:
        return state
    st = row.get("Status", "")
    if st.startswith("Up"):
        return "running"
    if "Exited" in st or "Dead" in st:
        return "exited"
    return "other"


def get_docker_data():
    try:
        img_rows = _docker_json(["images"])
        con_rows = _docker_ps()
    except Exception as e:
        return {"available": False, "error": f"{type(e).__name__}: {e}"}

    images = []
    for r in img_rows:
        images.append({
            "repository": r.get("Repository", "<none>"),
            "tag": r.get("Tag", "<none>"),
            "id": (r.get("ID") or "")[:12],
            "size": r.get("Size", ""),
            "size_bytes": _size_bytes(r.get("Size", "")),
            "created": r.get("CreatedSince", ""),
        })
    images.sort(key=lambda x: x["size_bytes"], reverse=True)

    containers = []
    for r in con_rows:
        containers.append({
            "name": r.get("Names", ""),
            "image": r.get("Image", ""),
            "state": _state_of(r),
            "status": r.get("Status", ""),
            "created": r.get("RunningFor", ""),
            "ports": r.get("Ports", ""),
        })
    # running first; docker already returns the rest newest-first
    containers.sort(key=lambda c: 0 if c["state"] == "running" else 1)

    return {
        "available": True,
        "images": images,
        "containers": containers,
        "counts": {
            "images": len(images),
            "containers": len(containers),
            "running": sum(1 for c in containers if c["state"] == "running"),
        },
    }
