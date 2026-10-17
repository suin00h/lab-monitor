import os
import threading
from collections import defaultdict

import psutil

import user_map
from config import get_config
from monitors import container

_lock = threading.Lock()
_cache: dict = {}

# coding agents — rolled into a single "Agents" line, not shown per-user
AGENT_NAMES = ("claude", "codex", "cursor")
# agents whose executable is named by version so the basename carries no agent
# name (e.g. the Claude remote CLI ~/.claude/remote/ccd-cli/<version> and its
# session server ~/.claude/remote/srv/.../server) — matched by executable path.
# Only the executable (cmd_list[0]) is checked, so a shell that merely passes
# a ".claude/..." path as an argument is not misclassified.
AGENT_PATH_SIGNATURES = (".claude/remote/",)
# infra processes — counted toward the total but folded into "Other" (not named)
# "/usr/bin/containerd" also catches the "/usr/bin/containerd-shim-runc-v2 ..." shims
HIDE_SUBSTRINGS = ("/usr/bin/dockerd", "/usr/bin/containerd", "/lib/systemd")
# desktop/GUI processes — display server, window/session managers, session
# daemons, audio, input methods. Rolled into one "Desktop / GUI" line so a
# workstation host (one with a physical display) isn't swamped by low-interest
# GUI noise. Matched by process-name prefix; headless servers simply have none.
GUI_NAME_PREFIXES = (
    "xorg", "xwayland", "gnome", "gsd-", "gdm", "mutter", "gjs", "dconf",
    "plasma", "kwin", "kded", "ksmserver", "kactivitymanager", "startplasma",
    "sddm", "lightdm", "xfwm4", "xfce4", "xfsettingsd", "cinnamon", "muffin",
    "mate-", "marco", "lxqt", "lxsession", "openbox",
    "pulseaudio", "pipewire", "wireplumber",
    "ibus", "fcitx", "at-spi", "gvfs", "tracker", "xdg-", "colord",
    "nautilus", "nm-applet", "update-notifier", "upowerd",
)
# only groups with combined RSS above this get their own named row; the rest → "Other"
NAMED_MIN_RSS = 50
TOP_N = 15


def get_pss_mb(pid):
    # Attribute ANONYMOUS PSS per owner. smaps_rollup "Pss:" also includes
    # file-backed (Pss_File) and shmem pages — but those live in the page CACHE,
    # not in `used`. Counting them here made Σ PSS exceed `used` on hosts that
    # mmap large files (e.g. an ML box loading datasets/weights), which broke the
    # reconciliation: osOverhead = used − Σpss went negative and the bar
    # overflowed. Pss_Anon is the slice that actually sits in `used`, so it
    # reconciles cleanly and never double-counts the cache. Fall back to Pss on
    # kernels too old to expose Pss_Anon.
    pss = anon = None
    try:
        with open(f"/proc/{pid}/smaps_rollup", "r") as f:
            for line in f:
                if line.startswith("Pss_Anon:"):
                    anon = int(line.split()[1]) / 1024
                elif line.startswith("Pss:"):
                    pss = int(line.split()[1]) / 1024
    except: return 0
    return anon if anon is not None else (pss or 0)


def _is_agent(name, cmd_list):
    if name.lower() in AGENT_NAMES:
        return True
    if cmd_list:
        exe = cmd_list[0].lower()
        if any(a in os.path.basename(exe) for a in AGENT_NAMES):
            return True
        if any(sig in exe for sig in AGENT_PATH_SIGNATURES):
            return True
    return False


def _is_gui(name):
    n = name.lower()
    return any(n.startswith(p) for p in GUI_NAME_PREFIXES)


def _agent_label(name, cmd_list):
    # which agent this process is — shown instead of the full command in the Agents group
    if name.lower() in AGENT_NAMES:
        return name.lower()
    exe = cmd_list[0].lower() if cmd_list else ""
    for a in AGENT_NAMES:
        if a in os.path.basename(exe):
            return a
    if any(sig in exe for sig in AGENT_PATH_SIGNATURES):
        return "claude"  # Claude remote CLI / session server (version-named exe)
    return name.lower()


def collect():
    temp_groups = defaultdict(lambda: {"rss": 0.0, "pss": 0.0, "count": 0, "user": "", "label": "", "procs": []})
    agent = {"rss": 0.0, "pss": 0.0, "count": 0, "procs": []}
    gui = {"rss": 0.0, "pss": 0.0, "count": 0, "procs": []}   # desktop/GUI noise
    other = {"rss": 0.0, "pss": 0.0, "count": 0}   # infra + tiny procs + groups past TOP_N
    total_pss_mb = 0.0  # Σ PSS over ALL processes — the full attributable total

    for proc in psutil.process_iter(['pid', 'name', 'username', 'memory_info', 'cmdline']):
        try:
            pinfo = proc.info
            rss = pinfo['memory_info'].rss / (1024**2)
            cmd_list = pinfo['cmdline'] or [pinfo['name']]
            full_cmd = " ".join(cmd_list)
            pss = get_pss_mb(pinfo['pid'])
            total_pss_mb += pss  # everything counts toward the reconciled total

            if _is_agent(pinfo['name'], cmd_list):
                agent["rss"] += rss; agent["pss"] += pss; agent["count"] += 1
                agent["procs"].append({"pid": pinfo['pid'], "cmd": _agent_label(pinfo['name'], cmd_list), "rss": round(rss, 1), "pss": round(pss, 1)})
                continue
            if _is_gui(pinfo['name']):
                gui["rss"] += rss; gui["pss"] += pss; gui["count"] += 1
                gui["procs"].append({"pid": pinfo['pid'], "cmd": full_cmd, "rss": round(rss, 1), "pss": round(pss, 1)})
                continue
            if any(s in full_cmd for s in HIDE_SUBSTRINGS) or rss < NAMED_MIN_RSS:
                other["rss"] += rss; other["pss"] += pss; other["count"] += 1
                continue

            user = pinfo['username']
            display_user = user_map.display_name(user)
            if user == 'root':  # container job — infer real owner via Docker
                inferred = container.owner_for_pid(pinfo['pid'])
                if inferred:
                    display_user = inferred
            if "uvicorn" in full_cmd and "main:app" in full_cmd:
                label = get_config()["site_title"]
                display_user = "Server"
            elif "python" in pinfo['name'].lower() or (len(cmd_list) > 1 and "python" in cmd_list[0]):
                py_file = next((arg for arg in cmd_list[1:] if arg.endswith('.py')), "Python Process")
                label = f"Python: {os.path.basename(py_file)}"
            elif "vscode-server" in full_cmd:
                label = "VS Code Server"
            else:
                label = pinfo['name']
            group_key = f"{label} ({display_user})"
            g = temp_groups[group_key]
            g["rss"] += rss; g["pss"] += pss; g["count"] += 1
            g["user"] = display_user; g["label"] = label
            g["procs"].append({"pid": pinfo['pid'], "cmd": full_cmd, "rss": round(rss, 1), "pss": round(pss, 1)})
        except: continue

    # top-N named groups by PSS; everything below folds into "기타"
    named = sorted(temp_groups.items(), key=lambda x: x[1]['pss'], reverse=True)
    final_groups = []
    for name, data in named[:TOP_N]:
        data["procs"].sort(key=lambda p: p["pss"], reverse=True)
        data["rss"] = round(data["rss"], 1)
        data["pss"] = round(data["pss"], 1)
        final_groups.append({"name": name, **data})
    for _, data in named[TOP_N:]:
        other["rss"] += data["rss"]; other["pss"] += data["pss"]; other["count"] += data["count"]

    vm = psutil.virtual_memory()
    used_mb = vm.used / (1024**2)
    kernel_os_mb = max(0.0, used_mb - total_pss_mb)  # unattributed: slab, page tables, tmpfs, etc.

    # summary buckets appended after the named groups
    if agent["count"]:
        agent["procs"].sort(key=lambda p: p["pss"], reverse=True)
        final_groups.append({
            "name": "__agents__", "label": "Agents", "user": "—",
            "count": agent["count"], "rss": round(agent["rss"], 1), "pss": round(agent["pss"], 1),
            "synthetic": True, "procs": agent["procs"],
        })
    if gui["count"]:
        gui["procs"].sort(key=lambda p: p["pss"], reverse=True)
        final_groups.append({
            "name": "__gui__", "label": "Desktop / GUI", "user": "—",
            "count": gui["count"], "rss": round(gui["rss"], 1), "pss": round(gui["pss"], 1),
            "synthetic": True, "procs": gui["procs"],
        })
    if other["count"]:
        final_groups.append({
            "name": "__other__", "label": "Other", "user": "—",
            "count": other["count"], "rss": round(other["rss"], 1), "pss": round(other["pss"], 1),
            "synthetic": True, "procs": [],
        })
    final_groups.append({
        "name": "__kernel__", "label": "Kernel / OS", "user": "—",
        "count": 0, "rss": 0.0, "pss": round(kernel_os_mb, 1),
        "synthetic": True, "procs": [],
    })

    return {
        "total": vm.total / (1024**3), "used": vm.used / (1024**3),
        "total_pss": total_pss_mb / 1024, "available": vm.available / (1024**3),
        "cached": getattr(vm, 'cached', 0) / (1024**3),
        "percent": vm.percent, "process_groups": final_groups,
    }


def get_cache():
    with _lock:
        return _cache


def set_cache(data):
    global _cache
    with _lock:
        _cache = data
