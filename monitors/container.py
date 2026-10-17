import re
import subprocess

import user_map

# Map a host pid that belongs to a Docker container to the owning lab member.
# Container jobs run as root, but each container bind-mounts the owner's
# /home/<id>, so: pid -> /proc/<pid>/cgroup -> docker id -> docker inspect
# mounts -> /home/<id> -> display name. Results cache per (long-lived) container.
_DOCKER_RE = re.compile(r'(?:docker[-/])([0-9a-f]{12,64})')
_HOME_RE = re.compile(r'^/home/([^/\s]+)')
_DATA_RE = re.compile(r'^/data/([^/\s]+)')
_cache: dict = {}  # container_id -> display name (or None)


def _container_id_for_pid(pid):
    try:
        with open(f"/proc/{pid}/cgroup", "r") as f:
            data = f.read()
    except OSError:
        return None
    m = _DOCKER_RE.search(data)
    return m.group(1) if m else None


def _owner_from_container(cid):
    """Raises on docker failure (so caller can retry); returns name or None."""
    r = subprocess.run(
        ["docker", "inspect", cid, "--format", '{{range .Mounts}}{{.Source}}\n{{end}}'],
        capture_output=True, text=True, timeout=5,
    )
    if r.returncode != 0:
        raise RuntimeError("docker inspect failed")
    sources = [ln.strip() for ln in r.stdout.splitlines() if ln.strip()]
    home_ids = [m.group(1) for ln in sources if (m := _HOME_RE.match(ln))]
    data_ids = [m.group(1) for ln in sources if (m := _DATA_RE.match(ln))]
    candidates = home_ids + data_ids  # prefer /home over /data
    known = [c for c in candidates if c in user_map.get_user_map()]
    pick = known[0] if known else (candidates[0] if candidates else None)
    return user_map.display_name(pick) if pick else None


def owner_for_pid(pid):
    """Owner display name for a containerized pid, or None if not a container
    (or docker is unavailable)."""
    cid = _container_id_for_pid(pid)
    if not cid:
        return None
    if cid in _cache:
        return _cache[cid]
    try:
        name = _owner_from_container(cid)
    except Exception:
        return None  # transient docker error: don't cache, retry next poll
    _cache[cid] = name
    return name


# ── GPU processes inside PID-isolated containers ──────────────────────
# A container without --pid=host has its own PID namespace, so nvidia-smi on
# the host reports a pid that isn't in host /proc — owner_for_pid() can't map
# it and it shows as "unknown". We instead join on (gpu_uuid, used_memory):
# ask each isolated container's own nvidia-smi what it sees, and match that
# against the host's unresolved GPU procs. Cached per host-pid (negatives too)
# so the container scan only runs when a *new* unknown pid appears.
_ns_cache: dict = {}  # host gpu pid -> owner display name or None


def _running_containers():
    """Running container ids, or None if docker itself is unavailable
    (distinguished from [] = docker fine but no containers)."""
    try:
        r = subprocess.run(["docker", "ps", "--format", "{{.ID}}"],
                           capture_output=True, text=True, timeout=5)
    except Exception:
        return None
    if r.returncode != 0:
        return None
    return [ln.strip() for ln in r.stdout.splitlines() if ln.strip()]


def _shares_host_pids(cid):
    r = subprocess.run(["docker", "inspect", cid, "--format", "{{.HostConfig.PidMode}}"],
                       capture_output=True, text=True, timeout=5)
    return r.returncode == 0 and r.stdout.strip() == "host"


def _container_gpu_procs(cid):
    """(gpu_uuid, used_mib) list as seen INSIDE the container, or [] if none."""
    r = subprocess.run(
        ["docker", "exec", cid, "nvidia-smi",
         "--query-compute-apps=used_memory,gpu_uuid", "--format=csv,noheader,nounits"],
        capture_output=True, text=True, timeout=8,
    )
    if r.returncode != 0:
        return []
    out = []
    for ln in r.stdout.splitlines():
        parts = [x.strip() for x in ln.split(",")]
        if len(parts) >= 2:
            try:
                out.append((parts[1], int(parts[0])))  # (uuid, mib)
            except ValueError:
                pass
    return out


def resolve_ns_owners(unresolved):
    """Map host GPU pids that couldn't be resolved to owner names.

    unresolved: list of {"pid", "uuid", "mem"} (host-reported values).
    Returns {pid: owner_name_or_None}. Scans containers only for pids not
    already cached; negative results are cached too, so a persistent unknown
    (e.g. a non-docker process) doesn't trigger a scan every poll.
    """
    current = {u["pid"] for u in unresolved}
    for pid in list(_ns_cache):            # drop pids that are gone
        if pid not in current:
            del _ns_cache[pid]
    need = [u for u in unresolved if u["pid"] not in _ns_cache]
    if need:
        cids = _running_containers()
        if cids is None:  # docker down — don't poison the cache, retry next poll
            return {u["pid"]: _ns_cache.get(u["pid"]) for u in unresolved}
        # (uuid, mib) -> owner, built from PID-isolated containers only
        mapping = {}
        for cid in cids:
            try:
                if _shares_host_pids(cid):     # its pids resolve on the host already
                    continue
                procs = _container_gpu_procs(cid)
                if not procs:
                    continue
                owner = _owner_from_container(cid)
                for uuid, mib in procs:
                    mapping[(uuid, mib)] = owner
            except Exception:
                continue
        for u in need:
            _ns_cache[u["pid"]] = mapping.get((u["uuid"], u["mem"]))
    return {u["pid"]: _ns_cache.get(u["pid"]) for u in unresolved}
