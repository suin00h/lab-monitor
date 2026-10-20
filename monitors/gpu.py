import os
import pwd
import threading

import pynvml

import user_map
from monitors import container

_lock = threading.Lock()
_cache: list = []
_nvml_ready = False  # NVML is init'd once and the handle reused across polls (not per 3s call)


def _ensure_nvml():
    global _nvml_ready
    if not _nvml_ready:
        pynvml.nvmlInit()
        _nvml_ready = True


def collect():
    global _nvml_ready
    try:
        _ensure_nvml()
        gpus = []
        unresolved = []  # (proc_entry, {pid, uuid, mem}) for PID-isolated container jobs
        for i in range(pynvml.nvmlDeviceGetCount()):
            handle = pynvml.nvmlDeviceGetHandleByIndex(i)
            mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
            util = pynvml.nvmlDeviceGetUtilizationRates(handle)
            temp = pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)
            uuid = pynvml.nvmlDeviceGetUUID(handle)
            if isinstance(uuid, bytes):
                uuid = uuid.decode('utf-8', errors='replace')
            procs = []
            for p in pynvml.nvmlDeviceGetComputeRunningProcesses(handle):
                mem_mib = p.usedGpuMemory // (1024**2)
                try:
                    sys_id = pwd.getpwuid(os.stat(f"/proc/{p.pid}").st_uid).pw_name
                    display_name = user_map.display_name(sys_id)
                    if sys_id == "root":  # container job — infer real owner
                        inferred = container.owner_for_pid(p.pid)
                        if inferred:
                            display_name = inferred
                except: display_name = "unknown"
                entry = {"user": display_name, "usage": mem_mib, "pid": p.pid}
                if display_name == "unknown":  # likely a PID-isolated container job
                    unresolved.append((entry, {"pid": p.pid, "uuid": uuid, "mem": mem_mib}))
                procs.append(entry)
            name = pynvml.nvmlDeviceGetName(handle)
            if isinstance(name, bytes):
                name = name.decode('utf-8', errors='replace')
            gpus.append({
                "id": i, "name": name,
                "total_mem": mem.total // (1024**2), "used_mem": mem.used // (1024**2),
                "gpu_util": util.gpu, "temp": temp, "processes": procs
            })
        # batched fallback: match unknown host pids to their owning container
        if unresolved:
            try:
                owners = container.resolve_ns_owners([u for _, u in unresolved])
                for entry, u in unresolved:
                    name = owners.get(u["pid"])
                    if name:
                        entry["user"] = name
            except Exception:
                pass
        return gpus
    except:
        _nvml_ready = False  # force a clean re-init on the next poll after a driver hiccup
        return []


def get_cache():
    with _lock:
        return _cache


def set_cache(data):
    global _cache
    with _lock:
        _cache = data
