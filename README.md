# Lab Monitor

A self-hosted dashboard for lab / GPU servers. One lightweight FastAPI app per
machine shows, in a dark web UI:

- **GPU** — per-card utilization, temperature, VRAM, and **who** is using each
  slice of memory (per-process, color-coded by user), with a per-process comment
  feed ("done in ~1h").
- **System Memory** — real per-owner memory (PSS), CPU load / utilization / PSI
  pressure.
- **Disk** — partition usage plus a drill-down size breakdown of chosen roots.
- **Docker** — running containers and local images.
- **Multi-host** — one machine can poll your other machines and show them all
  behind a single URL, with a host switcher in the top-right.

It is read-only: it reports on the machine, it does not control it.

<!-- ![tabs: GPU · System Memory · Disk · Docker, with a host switcher]() -->
<!-- drop a screenshot in docs/ and link it here -->

---

## 1. Requirements

- **Linux** (reads `/proc`, runs `du`, talks to the NVIDIA driver).
- **Python 3.12**.
- **NVIDIA driver** for the GPU tab (via `nvidia-ml-py`). CPU-only hosts can
  delete that line from `requirements.txt`; the rest still works.
- **Docker** (optional) for the Docker tab — the user the app runs as must be
  able to run `docker ps` / `docker images`.

---

## 2. Install

```bash
git clone <your-fork-url> lab-monitor
cd lab-monitor

# a virtualenv (or conda — your choice)
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

---

## 3. Configure

**Everything you tune lives in one file, `config.json`.** Copy the example and
edit it:

```bash
cp config.example.json config.json
```

```jsonc
{
  "site_title": "Our Lab",            // shown in the browser tab + page header
  "host_name": "gpu-01",              // this machine's label in the host switcher
  "port": 8000,                        // the port uvicorn listens on

  // Linux username (or Docker-inferred owner) -> the name shown in the UI.
  // Anything not listed shows the raw username.
  "user_map": {
    "alice": "Alice Kim",
    "bob":   "Bob Lee"
  },

  // other machines THIS instance should poll and show behind its own URL.
  // Leave [] for a single machine. See section 6.
  "remote_hosts": [
    { "id": "gpu-02", "name": "GPU 02", "base_url": "http://10.0.0.6:8000" }
  ],

  "disk": {
    "breakdown_roots": ["/data", "/home"],  // show top-level sizes for these
    "drill_roots":     ["/data"]            // ...but only let the browser open these
  }
}
```

`config.json` is **read live** — edits to `user_map`, `remote_hosts`, `disk`, and
`site_title` take effect within a few seconds, **no restart needed**. Only `port`
and the `intervals` block (poll cadence; sensible defaults are built in) are read
at startup.

> `config.json` is git-ignored on purpose: it holds your roster and internal IPs.
> Never commit it. Share changes by editing it on each host, or with your own
> private deployment mechanism.

---

## 4. Run

Quick test:

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
# open http://<this-machine-ip>:8000
```

`--host 0.0.0.0` exposes it on your network; `--host 127.0.0.1` keeps it
local-only (e.g. behind a reverse proxy — see section 7).

### As a service (recommended)

A template unit is included. Edit the three `>>>` lines in
`lab-monitor.service` (run-as user, checkout path, uvicorn path + port), then:

```bash
sudo cp lab-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lab-monitor
sudo systemctl status lab-monitor      # check it came up
```

Restart only after you change **Python** code. Static files and `config.json`
are picked up without a restart.

```bash
sudo systemctl restart lab-monitor
```

> **Why run as root?** Reading another user's real memory (PSS) and resolving the
> owner of root-owned container GPU jobs needs privilege. If you don't need
> per-user attribution to be exact, a normal user works too — it simply shows
> less for processes it can't inspect.

---

## 5. How the web UI is served (the part you host however you like)

There is **no separate frontend build**. The same uvicorn process serves both:

- the JSON API under `/api/...`, and
- the static UI (`GET /` → `static/index.html`, plus `/static/...`).

So "hosting the website" just means **making that one HTTP port reachable** by
whoever should see it. Pick the exposure that matches your situation:

| You want…                                   | Do this                                                            |
|---------------------------------------------|--------------------------------------------------------------------|
| Access from the same LAN only               | Run with `--host 0.0.0.0`; open the port in the host firewall.     |
| A clean URL / HTTPS / a domain              | Put **nginx** or **Caddy** in front as a reverse proxy (section 7).|
| Access from outside without opening ports   | A tunnel: **Tailscale**, **cloudflared**, or `ssh -R` (section 7). |

That's the only hint you need for the web layer — everything downstream (TLS,
domain, auth gateway) is a standard reverse-proxy/tunnel setup and is up to you.

---

## 6. Multi-host setup (the networking guide)

One instance (call it the **aggregator**) can display every machine. The model:

```
        browser
           │  (one URL)
           ▼
   ┌───────────────┐   polls /api/*    ┌───────────────┐
   │  aggregator   │ ────────────────▶ │   gpu-02      │  (same app, any host)
   │  (gpu-01)     │ ────────────────▶ │   gpu-03      │
   │  serves UI    │                   └───────────────┘
   └───────────────┘
```

- **Every machine runs this same app** with its own `config.json` (its own
  `host_name`, `user_map`, etc.).
- On **remote** machines you don't even need the UI — just the API reachable.
  They need no `remote_hosts` of their own.
- On the **aggregator**, list the others under `remote_hosts`. It polls each one
  every few seconds, caches the result, and re-serves it. A slow or down host
  never blocks the dashboard; it just shows as offline.

**`base_url` is how the aggregator reaches that host's API** — so it must be an
address the *aggregator* can open, not the browser. Three common cases:

### a) All machines on the same LAN (simplest)
On each remote: run with `--host 0.0.0.0` and open its port to the LAN:

```bash
# Ubuntu/UFW example on gpu-02, allowing only the aggregator's IP
sudo ufw allow from 10.0.0.5 to any port 8000 proto tcp
```

On the aggregator's `config.json`:
```json
"remote_hosts": [{ "id": "gpu-02", "name": "GPU 02", "base_url": "http://10.0.0.6:8000" }]
```

### b) Machines behind a router / different networks (NAT)
You need the remote's API reachable from the aggregator across the boundary:

1. **Port-forward** on the remote's router: external port → the machine's
   `IP:8000`.
2. **Restrict the source** so it isn't open to the whole internet — forward only
   from the aggregator's public IP (router ACL), and/or firewall it on the host:
   ```bash
   sudo ufw allow from <AGGREGATOR_PUBLIC_IP> to any port 8000 proto tcp
   ```
3. Point `base_url` at the router's public address + forwarded port:
   ```json
   { "id": "gpu-02", "name": "GPU 02", "base_url": "http://203.0.113.20:9002" }
   ```

### c) Easiest + safest across networks: a private mesh (recommended)
Install **[Tailscale](https://tailscale.com)** (or any WireGuard mesh) on every
machine. Each gets a stable private IP and traffic is encrypted — **no
port-forwarding, no public exposure**. Then just:
```json
{ "id": "gpu-02", "name": "GPU 02", "base_url": "http://100.x.y.z:8000" }
```

### Verify reachability
From the **aggregator**, before adding a host, confirm you can reach its API:

```bash
curl -s http://<host-address>:<port>/api/gpu | head -c 200   # expect JSON
```

If that returns JSON, the dashboard will show it. If it hangs or refuses, it's a
network/firewall issue (above), not the app. Offline hosts appear dimmed in the
switcher with the error on hover.

---

## 7. Reverse proxy / public hosting (optional)

If you want a domain + HTTPS, run the app on `127.0.0.1` and front it. Caddy is
the shortest path (automatic HTTPS):

```
# Caddyfile
monitor.example.edu {
    reverse_proxy 127.0.0.1:8000
}
```

nginx equivalent:

```nginx
server {
    listen 80;
    server_name monitor.example.edu;
    location / { proxy_pass http://127.0.0.1:8000; proxy_set_header Host $host; }
}
```

No open ports at all? Expose it through a tunnel instead:

```bash
tailscale funnel 8000           # or:  cloudflared tunnel --url http://localhost:8000
```

---

## 8. Security notes (read before exposing it)

- **There is no login.** Anyone who can reach the port sees everything the
  dashboard shows (processes, usernames, memory, disk breakdown). Keep it on a
  LAN/VPN, or put authentication in your reverse proxy, before exposing it.
- **Disk drilling is sandboxed** to `disk.drill_roots`; paths are resolved so
  symlinks can't escape. Keep `drill_roots` to directories you're comfortable
  letting viewers browse. `breakdown_roots` only shows *sizes*, not contents.
- **The GPU comment feed is unauthenticated** (a shared internal scratchpad);
  anyone who can see a host can post/delete comments on it.
- **`config.json` stays out of git** — it has your roster and internal
  addresses. Only `config.example.json` is committed.

---

## 9. Project layout

```
main.py              FastAPI app: static UI + /api, no-cache middleware
config.py            loads config.json (live) + startup constants
hosts.py             local + remote host registry (from config)
user_map.py          id -> display name (from config)
routers/system.py    all /api endpoints (metrics, hosts, config, gpu_notes)
monitors/            one collector per metric:
  gpu, cpu, memory, disk, docker_status, container (owner inference),
  remote (polls other hosts), scheduler (background threads)
static/              index.html + css + js (vanilla, no build step)
config.example.json  template — copy to config.json
lab-monitor.service  systemd unit template
```

## License

MIT — see [LICENSE](LICENSE).
