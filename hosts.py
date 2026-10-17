"""Host registry for multi-host aggregation.

The local host is always present. Remote hosts are read live from config.json
(the "remote_hosts" key) so a new server can be added without a code change or
restart — the poller and API pick it up on the next cycle.

    "remote_hosts": [
        {"id": "node2", "name": "Node 2", "base_url": "http://10.0.0.5:8000"}
    ]
"""
from config import LOCAL_HOST_ID, get_config


def local_host() -> dict:
    return {"id": LOCAL_HOST_ID, "name": get_config()["host_name"]}


def remote_hosts() -> list:
    out = []
    for h in get_config().get("remote_hosts") or []:
        if isinstance(h, dict) and h.get("id") and h.get("base_url"):
            out.append({
                "id": h["id"],
                "name": h.get("name", h["id"]),
                "base_url": str(h["base_url"]).rstrip("/"),
            })
    return out


def all_hosts() -> list:
    return [local_host()] + remote_hosts()


def find_remote(host_id: str):
    for h in remote_hosts():
        if h["id"] == host_id:
            return h
    return None


def is_local(host_id: str) -> bool:
    return not host_id or host_id == LOCAL_HOST_ID
