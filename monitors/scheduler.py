import time
import threading

from config import MEM_PSS_INTERVAL, GPU_INTERVAL, SUBDIR_INTERVAL, REMOTE_POLL_INTERVAL
from monitors import gpu, memory, disk, remote, cpu


def _background_scheduler():
    last_pss_update = 0
    while True:
        now = time.time()
        gpu.set_cache(gpu.collect())
        cpu.set_cache(cpu.collect())
        if now - last_pss_update >= MEM_PSS_INTERVAL:
            memory.set_cache(memory.collect())
            last_pss_update = now
        time.sleep(GPU_INTERVAL)


def _subdir_scheduler():
    while True:
        try:
            disk.collect_subdirs()
        except Exception:
            pass
        time.sleep(SUBDIR_INTERVAL)


def _remote_scheduler():
    # dormant while data/remote_hosts.json is absent/empty; picks up hosts live
    while True:
        try:
            remote.poll_once()
        except Exception:
            pass
        time.sleep(REMOTE_POLL_INTERVAL)


def init_caches():
    gpu.set_cache(gpu.collect())
    cpu.set_cache(cpu.collect())
    memory.set_cache(memory.collect())


def start_background_threads():
    threading.Thread(target=_background_scheduler, daemon=True).start()
    threading.Thread(target=_subdir_scheduler, daemon=True).start()
    threading.Thread(target=_remote_scheduler, daemon=True).start()
    # kick off first subdir collection non-blocking
    threading.Thread(target=disk.collect_subdirs, daemon=True).start()
