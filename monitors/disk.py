import os
import time
import threading
import subprocess
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

import psutil

from config import get_config

# Which roots get a top-level size breakdown, and which of those may be *drilled
# into* from the browser, are configured in config.json → "disk". drill_roots is
# a privacy guard: keep it a subset of breakdown_roots (e.g. show /home sizes but
# only let users browse into /data). Read live so config edits need no restart.


def _breakdown_roots():
    return list(get_config()["disk"].get("breakdown_roots") or [])


def _drill_roots():
    return [str(Path(p).resolve()) for p in (get_config()["disk"].get("drill_roots") or [])]


def _drill_allowed(target: Path) -> bool:
    ts = str(target)
    return any(ts == r or ts.startswith(r.rstrip("/") + "/") for r in _drill_roots())

_subdir_cache: dict = {}
_subdir_lock = threading.Lock()

# on-demand drill-down cache: resolved path -> (timestamp, entries)
_dir_cache: dict = {}
_dir_cache_lock = threading.Lock()
_DIR_TTL = 600  # seconds


def _du_bytes(path: str) -> int:
    try:
        r = subprocess.run(["du", "-sb", path], capture_output=True, text=True, timeout=120)
        if r.returncode == 0:
            return int(r.stdout.split()[0])
    except Exception:
        pass
    return 0


def list_dir(path: str):
    """Immediate children of `path` (dirs + files) with sizes, sorted desc.
    Restricted to the configured drill_roots; symlinks are resolved so they
    can't escape."""
    target = Path(path).resolve()
    if not _drill_allowed(target):
        raise PermissionError("path not under an allowed drill root")
    if not target.is_dir():
        raise FileNotFoundError(str(target))

    key = str(target)
    now = time.time()
    with _dir_cache_lock:
        cached = _dir_cache.get(key)
        if cached and now - cached[0] < _DIR_TTL:
            return cached[1]

    try:
        children = list(os.scandir(key))
    except (PermissionError, OSError):
        children = []

    results = []
    with ThreadPoolExecutor(max_workers=min(8, len(children) or 1)) as ex:
        fut_meta = {}
        for e in children:
            try:
                is_dir = e.is_dir(follow_symlinks=False)
            except OSError:
                is_dir = False
            fut_meta[ex.submit(_du_bytes, e.path)] = (e.name, is_dir)
        for fut in as_completed(fut_meta):
            name, is_dir = fut_meta[fut]
            used = fut.result()
            if used > 0:
                results.append({"name": name, "used": used, "is_dir": is_dir})

    results.sort(key=lambda x: x["used"], reverse=True)
    with _dir_cache_lock:
        _dir_cache[key] = (now, results)
    return results


def collect_subdirs():
    """Background pass: top-level dir sizes for each configured breakdown root."""
    result = {}
    for base_path in _breakdown_roots():
        bp = Path(base_path)
        if not bp.exists():
            continue
        try:
            # include files as well as directories, so a root with only files
            # (e.g. a fresh /data that just has a README) still shows up
            scan = [e for e in os.scandir(str(bp)) if not e.name.startswith(".")]
        except (PermissionError, OSError):
            continue

        entries = []
        with ThreadPoolExecutor(max_workers=min(8, len(scan) or 1)) as ex:
            fut_to_e = {ex.submit(_du_bytes, e.path): e for e in scan}
            for fut in as_completed(fut_to_e):
                e = fut_to_e[fut]
                used = fut.result()
                if used > 0:
                    entries.append({"name": e.name, "used": used,
                                    "is_dir": e.is_dir(follow_symlinks=False)})

        # register the root even when empty, so an existing-but-empty breakdown
        # root is shown (as empty) instead of silently vanishing
        result[base_path] = sorted(entries, key=lambda x: x["used"], reverse=True)

    with _subdir_lock:
        _subdir_cache.clear()
        _subdir_cache.update(result)


def get_disk_data():
    SKIP_FS = {"tmpfs","devtmpfs","squashfs","overlay","none","cgroup",
               "cgroup2","pstore","bpf","tracefs","debugfs","securityfs",
               "hugetlbfs","mqueue","fusectl","proc","sysfs","devpts"}
    partitions = []
    for p in psutil.disk_partitions(all=False):
        if p.fstype in SKIP_FS:
            continue
        try:
            usage = psutil.disk_usage(p.mountpoint)
            if usage.total < 1e9:
                continue
            partitions.append({
                "device": p.device, "mountpoint": p.mountpoint,
                "fstype": p.fstype, "total": usage.total,
                "used": usage.used, "free": usage.free, "percent": usage.percent,
            })
        except (PermissionError, OSError):
            continue

    with _subdir_lock:
        subdirs = dict(_subdir_cache)

    return {"partitions": partitions, "subdirs": subdirs, "drill_roots": _drill_roots()}
