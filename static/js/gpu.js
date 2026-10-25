        // ── GPU ───────────────────────────────────────────
        // per-process VRAM: MiB up to 10 GiB, then GiB. short=true for the compact
        // in-block label ("13.3G"), false for the full tooltip ("13.3 GiB").
        function gpuMem(mib, short) {
            if(mib >= 10000) { const g = (mib/1024).toFixed(1); return short ? g + 'G' : g + ' GiB'; }
            return short ? mib + 'M' : mib.toLocaleString() + ' MiB';
        }
        // per-process notes: shown on hover; relative time appended
        function gpuTimeAgo(ts) {
            const s = Math.floor(Date.now() / 1000) - ts;
            if(s < 60) return 'just now';
            if(s < 3600) return Math.floor(s / 60) + 'm ago';
            if(s < 86400) return Math.floor(s / 3600) + 'h ago';
            return Math.floor(s / 86400) + 'd ago';
        }
        function gpuNoteKey(gpuId, pid) { return (typeof currentHost !== 'undefined' ? currentHost : 'local') + ':' + gpuId + ':' + pid; }
        // Fun per-author icons. The comment author is a per-browser anonymous id;
        // a stable hash picks the icon + colour, so each person gets a recognizable
        // little avatar in the feed.
        const NOTE_ICONS = [
            '<path d="M12 2a7 7 0 00-7 7c0 2.4 1.2 4 2.5 5.2V17a1 1 0 001 1h1v2h5v-2h1a1 1 0 001-1v-2.8C17.8 13 19 11.4 19 9a7 7 0 00-7-7zM9.5 11a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm5 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3z"/>',
            '<path d="M12 3a6 6 0 00-6 6v9l2-1.5L10 18l2-1.5L14 18l2-1.5L18 18V9a6 6 0 00-6-6zm-2 6a1 1 0 110 2 1 1 0 010-2zm4 0a1 1 0 110 2 1 1 0 010-2z"/>',
            '<path d="M13 2L4.5 13H11l-1 9 8.5-11H12z"/>',
            '<path d="M12 2s5 4 5 9a5 5 0 01-10 0c0-2 1-3 1-3s0 2 2 2c0-3 2-5 2-8z"/>',
            '<path d="M12 2l2.9 6.3 6.9.7-5.1 4.6 1.4 6.8L12 17.8 5.9 20.4l1.4-6.8L2.2 9l6.9-.7z"/>',
            '<path d="M12 21s-7-4.5-7-9.5A4.5 4.5 0 0112 8a4.5 4.5 0 017 3.5c0 5-7 9.5-7 9.5z"/>',
            '<path d="M3 8l4 3 5-6 5 6 4-3-2 11H5z"/>',
            '<path d="M12 2l7 7-7 13-7-13z"/>',
            '<path d="M20 13a8 8 0 11-8-11 6 6 0 008 11z"/>',
            '<path d="M7 7h10a3 3 0 013 3v4a3 3 0 01-3 3H7a3 3 0 01-3-3v-4a3 3 0 013-3zm1 4a1.5 1.5 0 100 3 1.5 1.5 0 000-3zm8 0a1.5 1.5 0 100 3 1.5 1.5 0 000-3z"/>',
            '<path d="M12 2a7 7 0 00-7 7c0 3 2 4 2 6h10c0-2 2-3 2-6a7 7 0 00-7-7zM9 9a1 1 0 110 2 1 1 0 010-2zm6 0a1 1 0 110 2 1 1 0 010-2zm-6 9h6v2a1 1 0 01-1 1h-4a1 1 0 01-1-1z"/>',
        ];
        function authorHash(a) { let h = 0; a = String(a || 'anon'); for(let i = 0; i < a.length; i++) h = (h * 31 + a.charCodeAt(i)) >>> 0; return h; }
        function authorIcon(a) { return `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">${NOTE_ICONS[authorHash(a) % NOTE_ICONS.length]}</svg>`; }
        function authorColor(a) { return `hsl(${authorHash('c' + a) % 360} 68% 62%)`; }
        // Per-user tint for VRAM blocks / owner rows. The palette is built FROM
        // the current theme accent (read live, so it tracks dark/light), not a
        // fixed hue: one present user holds the accent itself, every other user gets
        // a seat in the same tight accent family (see the selection logic below). Fed
        // into the block as --ub so the 15%/35% transparent fill design is untouched —
        // only the tint colour shifts, the opacity structure stays.
        let _gpuAcc = { h: 234, s: 83, l: 65 };
        // Colour "seats" (the hue/sat/light variation values) are tracked PER USER and
        // PER HOST, and PERSISTED to localStorage — so a user keeps ONE colour (the same
        // on every device) for as long as they have a live process, across reloads /
        // reconnects. Users who leave entirely are released; those still present are
        // NEVER reshuffled. A new user takes the accent if it's free, else the seat whose
        // tint is farthest (OKLab) from everything already shown.
        function _gpuLoadSeats() {
            try {
                const o = JSON.parse(localStorage.getItem('labmon.gpuSeats.v2') || '{}');
                const m = {};
                for(const h in o) m[h] = new Map(Object.entries(o[h]));   // keys are usernames (strings)
                return m;
            } catch(e) { return {}; }
        }
        function _gpuSaveSeats() {
            try {
                const o = {};
                for(const h in _gpuSeatByHost) { o[h] = {}; for(const [k, v] of _gpuSeatByHost[h]) o[h][k] = v; }
                localStorage.setItem('labmon.gpuSeats.v2', JSON.stringify(o));
            } catch(e) {}
        }
        let _gpuSeatByHost = _gpuLoadSeats();
        let _gpuActiveSeat = new Map();   // user -> seat, for the current host
        function gpuReadAccent() {
            const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
            let r, g, b;
            if(v.startsWith('#')) { const n = parseInt(v.slice(1), 16); r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255; }
            else { const m = v.match(/[\d.]+/g); if(!m || m.length < 3) return; [r, g, b] = m.map(Number); }
            r /= 255; g /= 255; b /= 255;
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
            const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
            let h = 0;
            if(d) { h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if(h < 0) h += 360; }
            _gpuAcc = { h, s: s * 100, l: l * 100 };
        }
        // ── Diversity-aware seat selection (keeps live colours visually distinct) ──
        // The colour POOL is unchanged (the accent-family tint below); only HOW a seat
        // is picked changed: a new process gets the candidate seat whose tint sits
        // farthest, in OKLab perceptual space, from every colour already on screen —
        // so freshly-assigned colours never land close to an existing one.
        const _GPU_CAND = 200;   // candidate seats (1.._GPU_CAND) in the family pool
        function _srgbLin(c){ c/=255; return c<=0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); }
        function _oklab(r, g, b){
            const R=_srgbLin(r), G=_srgbLin(g), B=_srgbLin(b);
            const l=0.4122214708*R+0.5363325363*G+0.0514459929*B,
                  m=0.2119034982*R+0.6806995451*G+0.1073969566*B,
                  s=0.0883024619*R+0.2817188376*G+0.6299787005*B;
            const l_=Math.cbrt(l), m_=Math.cbrt(m), s_=Math.cbrt(s);
            return [0.2104542553*l_+0.7936177850*m_-0.0040720468*s_,
                    1.9779984951*l_-2.4285922050*m_+0.4505937099*s_,
                    0.0259040371*l_+0.7827717662*m_-0.8086757660*s_];
        }
        function _hslToRgb(h, s, l){
            s/=100; l/=100;
            const c=(1-Math.abs(2*l-1))*s, hp=(((h%360)+360)%360)/60, x=c*(1-Math.abs(hp%2-1));
            let r=0,g=0,b=0;
            if(hp<1){r=c;g=x;} else if(hp<2){r=x;g=c;} else if(hp<3){g=c;b=x;}
            else if(hp<4){g=x;b=c;} else if(hp<5){r=x;b=c;} else {r=c;b=x;}
            const m=l-c/2; return [(r+m)*255,(g+m)*255,(b+m)*255];
        }
        function _seatLab(seat){ const t=_seatTint(seat); const [r,g,b]=_hslToRgb(t.h,t.s,t.l); return _oklab(r,g,b); }
        // the candidate seat whose tint is farthest from the accent + all taken seats
        function _farthestSeat(taken){
            const active = [_seatLab(0)];
            for(const s of taken) active.push(_seatLab(s));
            let best = 1, bestD = -1;
            for(let seat = 1; seat <= _GPU_CAND; seat++){
                if(taken.has(seat)) continue;
                const lab = _seatLab(seat);
                let mn = Infinity;
                for(const a of active){ const dx=lab[0]-a[0], dy=lab[1]-a[1], dz=lab[2]-a[2]; const d=dx*dx+dy*dy+dz*dz; if(d<mn) mn=d; }
                if(mn > bestD){ bestD = mn; best = seat; }
            }
            return best;
        }
        // Rebuild the registry once per render. A user KEEPS their seat for as long as
        // they have a live process (no reshuffle, ever). Users who leave every GPU are
        // released, freeing their colour — incl. the accent — for a future newcomer.
        // Persisted so reloads look identical.
        function gpuBuildColors(gpus) {
            gpuReadAccent();
            const host = (typeof currentHost !== 'undefined' && currentHost) ? currentHost : 'local';
            const seat = _gpuSeatByHost[host] || (_gpuSeatByHost[host] = new Map());
            _gpuActiveSeat = seat;
            const cur = new Set();
            for(const g of gpus) for(const p of g.processes) cur.add(p.user);
            let changed = false;
            // release users who left every GPU (NO reshuffle of the survivors)
            for(const u of [...seat.keys()]) if(!cur.has(u)) { seat.delete(u); changed = true; }
            // assign each new user: accent (seat 0) if free, else the farthest seat
            for(const u of cur) {
                if(seat.has(u)) continue;
                const taken = new Set(seat.values());
                seat.set(u, taken.has(0) ? _farthestSeat(taken) : 0);
                changed = true;
            }
            if(changed) _gpuSaveSeats();
        }
        // seat 0 = accent; higher seats step through the accent-family variations.
        // Keyed by USER: one colour per user (same on every device), stable while present.
        function gpuUserRank(user) { return _gpuActiveSeat.get(user) ?? 0; }
        // idx 0 = accent as-is. Higher seats: a sinusoidal embedding of the seat —
        // each channel (H/S/L) oscillates at a different IRRATIONAL frequency
        // (√2,√3,√5) with its own phase, so the three axes are mutually incommensurate.
        // Hue amplitude stays small (±28°) so it's blue–violet, not a rainbow; S/L
        // swing wide for contrast. Deterministic in seat → stable colour per process.
        function _seatTint(idx) {
            if(idx <= 0) return { h: _gpuAcc.h, s: _gpuAcc.s, l: _gpuAcc.l };
            return {
                h: ((_gpuAcc.h + Math.sin(idx * 1.41421) * 12) % 360 + 360) % 360,  // ±12° — stays one hue family
                s: 60 + Math.sin(idx * 1.73205 + 0.9) * 18,   // 42–78% — soft, never hyper-saturated
                l: 66 + Math.sin(idx * 2.23607 + 1.9) * 10,   // 56–76% — stays light, never a dark navy
            };
        }
        function gpuUserTint(idx) {
            const t = _seatTint(idx);
            return `hsl(${t.h.toFixed(0)} ${t.s.toFixed(0)}% ${t.l.toFixed(0)}%)`;
        }
        // GPU owner list — a hover trigger in the header ("N owners") that opens the
        // shared body-level popover. No inline space, so it never shifts the card
        // below; the full sorted list lives in the floating panel. Builds the panel
        // HTML into a data attribute (double-quotes escaped) read by the help handler.
        function gpuOwnersTrigger(gpu) {
            if(!gpu.processes.length) return '';
            // Aggregate by user: one owner may run many processes, so sum their
            // VRAM and count people, not PIDs (8 procs by 1 user = "1 owner").
            const byUser = new Map();
            for(const p of gpu.processes) byUser.set(p.user, (byUser.get(p.user) || 0) + p.usage);
            const owners = [...byUser.entries()].map(([user, usage]) => ({ user, usage })).sort((a, b) => b.usage - a.usage);
            const maxU = owners[0].usage || 1;
            const rows = owners.map((o) => { const col = gpuUserTint(gpuUserRank(o.user)); return `<div class="own-row"><span class="od" style="background:${col}"></span><span class="nm">${o.user}</span><span class="ob"><div style="width:${(o.usage / maxU * 100).toFixed(1)}%;background:${col}"></div></span><span class="v">${gpuMem(o.usage, false)}</span></div>`; }).join('');
            const payload = (`<div class="tip-h">Owners</div>${rows}`).replace(/"/g, '&quot;');
            const label = owners.length === 1 ? '1 Owner' : `${owners.length} Owners`;
            const chev = '<svg class="ochev" viewBox="0 0 20 20" width="12" height="12" fill="currentColor"><path d="M5.3 7.3a1 1 0 011.4 0L10 10.6l3.3-3.3a1 1 0 011.4 1.4l-4 4a1 1 0 01-1.4 0l-4-4a1 1 0 010-1.4z"/></svg>';
            return `<span class="gpu-owners" data-help="gpu-owners-${gpu.id}" data-help-html="${payload}">${label}${chev}</span>`;
        }

        // Thin vitals strip between the tab bar and the first GPU card: system
        // memory use + CPU pressure, at a glance, without leaving the GPU tab.
        function gpuVitals(mem, cpu) {
            const bar = (label, pct, val) => `<div class="gv"><span class="gv-l">${label}</span><div class="gv-track"><div class="gv-fill" data-bk="gv-${label}" style="width:${Math.min(100, pct).toFixed(1)}%"></div></div><span class="gv-v">${val}</span></div>`;
            const items = [];
            if(mem && mem.total) items.push(bar('MEM', mem.used / mem.total * 100, `${(mem.used / mem.total * 100).toFixed(0)}%`));
            if(cpu && cpu.pressure) items.push(bar('PRESSURE', cpu.pressure.avg10, `${cpu.pressure.avg10.toFixed(0)}%`));
            if(!items.length) return '';
            return `<div class="gpu-vitals">${items.join('<div class="gv-sep"></div>')}</div>`;
        }

        // Bar-width animation. The card is rebuilt via innerHTML each tick, so fresh bar
        // elements render at their final width with no "from" state. We cache each bar's
        // previous width (keyed by data-bk) and, right after the rebuild, seed the new
        // element with the old width (transition off), force a reflow, then set the target
        // width so the CSS width-transition animates. Removed bars are pruned.
        const _barCache = {};
        function _flipBars(root) {
            const seen = new Set();
            const plan = [];  // [el, targetWidth] for bars that moved
            root.querySelectorAll('[data-bk]').forEach(el => {
                const bk = el.dataset.bk; seen.add(bk);
                const target = el.style.width;
                const prev = _barCache[bk];
                _barCache[bk] = target;
                if(prev && prev !== target) {
                    el.style.transition = 'none';   // seed the old width without animating
                    el.style.width = prev;
                    plan.push([el, target]);
                }
            });
            if(plan.length) {
                void root.offsetWidth;              // ONE forced reflow for all seeded widths
                plan.forEach(([el, target]) => { el.style.transition = ''; el.style.width = target; });
            }
            for(const k in _barCache) if(!seen.has(k)) delete _barCache[k];
        }

        function renderGpu(gpus, targetId = 'content', mem = null, cpu = null, notes = {}) {
            const c = document.getElementById(targetId);
            window._gpuNotes = notes;  // let the shared note editor prefill current text
            gpuBuildColors(gpus);  // unified per-user colours (accent + stable queue)
            c.innerHTML = gpuVitals(mem, cpu) + gpus.map((gpu, idx) => {
                // Free VRAM is the operator's "can I run?" number — printed as a quiet grey
                // watermark in the bar's empty space (same voice as an idle GPU), so the
                // headroom reads right where the free room is, not as a loud hero figure.
                const free = gpu.total_mem - gpu.used_mem;
                // temp is the one coloured readout — a temperature scale: cool / warm / hot
                const tempColor = gpu.temp >= 85 ? 'var(--color-crit)' : gpu.temp >= 68 ? 'var(--color-warn)' : 'var(--available)';
                // bar fractions are per-process; only scale down if the sum would overflow
                const totalPct = gpu.total_mem ? gpu.processes.reduce((s, p) => s + (p.usage / gpu.total_mem) * 100, 0) : 0;
                const scale = totalPct > 100 ? 100 / totalPct : 1;
                const freePct = Math.max(0, 100 - totalPct * scale);
                const showWm = freePct >= 22;  // enough empty room to print the free amount inline (else it falls to the footer)
                return `
                <div class="mb-12">
                    <div class="flex justify-between items-center mb-4 px-1 gap-4">
                        <span class="text-xl font-black tracking-tight">#0${gpu.id} ${gpu.name}</span>
                        <span class="gpu-ut">
                            <span class="gpu-ut-g">
                                <span class="gpu-ut-l">Util</span>
                                <span class="gpu-ut-v">${gpu.gpu_util}%</span>
                                <span class="gpu-ut-bar"><div data-bk="u${gpu.id}" style="width:${gpu.gpu_util}%"></div></span>
                            </span>
                            <span class="gpu-ut-g">
                                <span class="gpu-ut-l">Temp</span>
                                <span class="gpu-ut-v" style="color:${tempColor}">${gpu.temp}°</span>
                                <span class="gpu-ut-bar"><div data-bk="t${gpu.id}" style="width:${Math.min(100, gpu.temp)}%;background:${tempColor}"></div></span>
                            </span>
                        </span>
                    </div>
                    <div class="gpu-bar-container">
                        ${gpu.processes.map(p => {
                            const pct = (p.usage / gpu.total_mem) * 100 * scale;
                            const nc = (notes[gpuNoteKey(gpu.id, p.pid)] || []).length;
                            const showText = pct > 6;
                            const small = showText ? '0' : '1';  // data for the hover feed tooltip
                            const uesc = String(p.user).replace(/'/g, "\\'");
                            return `<div class="vram-block${nc ? ' has-note' : ''}" data-bk="b${gpu.id}:${p.pid}" data-note-trigger data-gpu="${gpu.id}" data-pid="${p.pid}" data-user="${escapeHTML(p.user)}" data-usage="${gpuMem(p.usage, false)}" data-small="${small}" style="width:calc(${pct}% - 2px);--ub:${gpuUserTint(gpuUserRank(p.user))}" onclick="gpuNoteEdit(${gpu.id}, ${p.pid}, '${uesc}')">
                                ${showText ? `<span class="font-black tracking-tight text-base truncate w-full leading-none text-center px-1" style="color:var(--text)">${p.user}</span><span class="mono text-sm font-bold mt-1" style="color:var(--label)">${gpuMem(p.usage, true)}</span>` : ''}
                                ${nc ? '<span class="vb-note-dot"></span>' : ''}
                            </div>`;
                        }).join('')}
                        ${showWm ? `<div class="gpu-free-wm" style="width:calc(${freePct}% - 2px)">${free.toLocaleString()} MiB<span class="w">free</span></div>` : ''}
                    </div>
                    <div class="gpu-foot">
                        <span>${gpuOwnersTrigger(gpu)}</span>
                        <span class="gpu-foot-num">${showWm ? '' : `<span class="gf-free">${free.toLocaleString()} MiB free</span>`}<span class="gf-ut">${gpu.used_mem.toLocaleString()} / ${gpu.total_mem.toLocaleString()} MiB</span></span>
                    </div>
                    ${idx !== gpus.length - 1 ? '<div class="device-separator"></div>' : ''}
                </div>`;
            }).join('');
            _flipBars(c);  // animate bar widths from their previous values (smooth updates)
        }
