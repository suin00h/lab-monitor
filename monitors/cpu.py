"""CPU load / contention metrics.

Free RAM/VRAM doesn't mean the box is fast: if the CPU is saturated, GPU jobs
starve at the dataloader/preprocess stage (GPU util looks low, throughput
isn't). We surface three complementary signals:

- utilization %  — how busy the CPUs are (with a user/system/iowait breakdown;
  high iowait means the bottleneck is disk, not CPU).
- load average / cores — how oversubscribed the run queue is (load 310 on 32
  cores ≈ 10× over).
- PSI cpu pressure (/proc/pressure/cpu "some") — the share of time runnable
  tasks were stalled waiting for a CPU. This measures *contention* directly:
  100% utilization isn't necessarily bad, but high pressure always is.

All values come from psutil + /proc, no extra deps. Cached by the scheduler.
"""
import threading

import psutil

_cache: dict = {}
_lock = threading.Lock()


def _psi_cpu():
    """(some, full) dicts of avg10/avg60/avg300 from /proc/pressure/cpu, or
    None if PSI isn't available (older kernels / not mounted)."""
    try:
        out = {}
        with open("/proc/pressure/cpu") as f:
            for line in f:
                parts = line.split()
                kind = parts[0]  # "some" or "full"
                vals = {}
                for p in parts[1:]:
                    k, _, v = p.partition("=")
                    if k.startswith("avg"):
                        try:
                            vals[k] = float(v)
                        except ValueError:
                            pass
                out[kind] = vals
        return out.get("some"), out.get("full")
    except Exception:
        return None, None


def collect():
    # non-blocking deltas since the previous call (the scheduler loops, so these
    # reflect the last interval); first call after start returns ~0.
    util = psutil.cpu_percent(interval=None)
    t = psutil.cpu_times_percent(interval=None)
    try:
        load1, load5, load15 = psutil.getloadavg()
    except (OSError, AttributeError):
        load1 = load5 = load15 = 0.0
    cores = psutil.cpu_count(logical=True) or 1
    some, _full = _psi_cpu()

    return {
        "util": round(util, 1),
        "user": round(getattr(t, "user", 0.0), 1),
        "system": round(getattr(t, "system", 0.0), 1),
        "iowait": round(getattr(t, "iowait", 0.0), 1),
        "steal": round(getattr(t, "steal", 0.0), 1),
        "idle": round(getattr(t, "idle", 0.0), 1),
        "load": [round(load1, 2), round(load5, 2), round(load15, 2)],
        "cores": cores,
        # PSI "some" cpu pressure (% of time at least one task waited for CPU)
        "pressure": {
            "avg10": round(some.get("avg10", 0.0), 1),
            "avg60": round(some.get("avg60", 0.0), 1),
            "avg300": round(some.get("avg300", 0.0), 1),
        } if some else None,
    }


def get_cache():
    with _lock:
        return _cache


def set_cache(data):
    global _cache
    with _lock:
        _cache = data
