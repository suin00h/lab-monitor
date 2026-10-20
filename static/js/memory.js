        // ── Memory ────────────────────────────────────────
        // per-process value: MiB up to 10 GiB, then switch to GiB for readability
        function memProcVal(mib) {
            return mib >= 10000 ? (mib/1024).toFixed(1) + ' GiB' : Math.round(mib).toLocaleString() + ' MiB';
        }
        // Help-tooltip content, shown by a shared body-level tooltip (app.js) so it
        // survives the 3s re-render without flicker. Keyed by the badge's data-help.
        const HELP_TIPS = {
            cpu: '<span class="tip-h">Pressure</span>How much work is backed up waiting for the CPU. Low means headroom; high means tasks are queuing for their turn and everything slows down.'
               + '<span class="tip-h tip-h2">Utilization</span>The share of time the CPU is actually doing work. Closer to 100% means it is running flat out.'
               + '<span class="tip-h tip-h2">Load</span>Number of tasks using or waiting for the CPU (divided by core count). Above the core count means demand exceeds capacity.',
            mem: '<span class="tip-h">Available</span>Memory you can use right now. Plenty of it means new jobs are safe to start.'
               + '<span class="tip-h tip-h2">Tracked (PSS)</span>What processes actually occupy (shared memory is split proportionally).'
               + '<span class="tip-h tip-h2">Cache</span>Temporary space used to read files faster. It is reclaimed on demand, so it counts as free.'
               + '<span class="tip-h tip-h2">Free</span>Completely empty space, not used by anything.',
        };

        // ── Memory | CPU hero split (GPU-style: title/sub above the box, box holds
        //    a gauge ring + a breakdown list). Both cards share markup so they align.
        const _bd = rows =>`<div class="mbd">${rows.map(r => `<div class="it">${r.sw!==undefined?`<span class="sw" style="background:${r.sw}${r.sw==='var(--seg-free)'?';border:1px solid var(--label)':''}"></span>`:''}<span class="nm">${r.nm}</span><span class="v v-reg">${r.v}</span></div>`).join('')}</div>`;

        function memHeroCard(mem) {
            const g = v => v.toFixed(1) + ' GiB';
            const pss = mem.total_pss, overhead = Math.max(0, mem.used - mem.total_pss);
            const cache = mem.cached, free = Math.max(0, mem.total - mem.used - mem.cached);
            const T = mem.total || 1;
            // OUTER ring = composition (PSS=accent, the rest neutral grey steps)
            const comp = [[pss,'var(--accent)'],[overhead,'var(--seg-overhead)'],[cache,'var(--seg-cache)'],[free,'var(--seg-free)']];
            let a = 0; const compConic = comp.map(([v,col]) => { const p0=a/T*100; a+=v; return `${col} ${p0}% ${a/T*100}%`; }).join(',');
            // INNER ring = emerald Available arc, starting at 12 o'clock, counter-clockwise
            const start = (1 - mem.available / T) * 100;
            const availArc = `conic-gradient(var(--seg-free) 0 ${start}%, var(--available) ${start}% 100%)`;
            return `<div class="mcol">
                <div class="mhead"><span class="t">Memory</span><span class="s">${mem.used.toFixed(0)} / ${mem.total.toFixed(0)} GiB used<span class="help" data-help="mem">?</span></span></div>
                <div class="mbox">
                    <div class="mring" style="background:conic-gradient(${compConic})">
                        <div class="mring-inner" style="background:${availArc}">
                            <div class="c"><span class="k" style="color:var(--available)">Available</span><span class="n" style="color:var(--available);font-size:2rem">${mem.available.toFixed(0)}<span style="font-size:0.95rem">G</span></span></div>
                        </div>
                    </div>
                    ${_bd([
                        {sw:'var(--accent)', nm:'Tracked (PSS)', v:g(pss)},
                        {sw:'var(--seg-overhead)', nm:'OS Overhead', v:g(overhead)},
                        {sw:'var(--seg-cache)', nm:'Cache', v:g(cache)},
                        {sw:'var(--seg-free)', nm:'Free', v:g(free)},
                    ])}
                </div>
            </div>`;
        }

        // CPU status thresholds (PSI 'some' pressure, %). Outer ring = pressure
        // fill; inner ring = these zones, so the fill's leading edge lands in the
        // zone that names the state. Keep in sync with the status() logic below.
        const CPU_BUSY = 15, CPU_SAT = 50;
        function cpuHeroCard(cpu) {
            if(!cpu || cpu.util === undefined) {
                return `<div class="mcol"><div class="mhead"><span class="t">CPU</span></div>
                    <div class="mbox"><span style="color:var(--label)">No data</span></div></div>`;
            }
            const cores = cpu.cores || 1;
            const load1 = (cpu.load && cpu.load[0]) || 0, loadRatio = load1 / cores;
            const utilPct = Math.min(100, cpu.util || 0);
            const p = cpu.pressure, pr = p ? Math.min(100, p.avg10) : 0;
            const status = (pr >= CPU_SAT || loadRatio >= 1.5) ? 'Saturated'
                         : (pr >= CPU_BUSY || loadRatio >= 0.8) ? 'Busy' : 'Idle';
            // outer ring = pressure fill (accent); inner ring = threshold zones
            const pressureArc = `conic-gradient(var(--accent) 0 ${pr}%, var(--seg-free) ${pr}% 100%)`;
            const zoneRing = `conic-gradient(var(--z1) 0 ${CPU_BUSY}%, var(--z2) ${CPU_BUSY}% ${CPU_SAT}%, var(--z3) ${CPU_SAT}% 100%)`;
            // Utilization gets a GPU-style small horizontal bar in the list
            const utilRow = `<div class="it" style="flex-direction:column;align-items:stretch;gap:0">
                <div style="display:flex;align-items:center"><span class="nm">Utilization</span><span class="v">${utilPct.toFixed(0)}%</span></div>
                <div class="ubar"><div style="width:${utilPct}%"></div></div></div>`;
            // iowait lives in the header (next to ?) so it holds its slot instead
            // of popping in/out of the list and shifting the layout.
            const io = Number(cpu.iowait) || 0;
            // legend for the inner threshold ring (ranges from the CPU_* constants)
            const thRow = (col, nm, range) => `<div class="th-it"><span class="sw" style="background:${col}"></span><span class="th-nm">${nm}</span><span class="th-v">${range}</span></div>`;
            const thresholds = `<div class="cpu-th">
                <div class="it"><span class="nm">Status</span><span class="v v-reg">${status}</span></div>
                ${thRow('var(--z1)', 'Idle', `&lt; ${CPU_BUSY}%`)}
                ${thRow('var(--z2)', 'Busy', `${CPU_BUSY}–${CPU_SAT}%`)}
                ${thRow('var(--z3)', 'Saturated', `≥ ${CPU_SAT}%`)}
            </div>`;
            return `<div class="mcol">
                <div class="mhead"><span class="t">CPU</span><span class="s">iowait ${io.toFixed(0)}%<span class="help" data-help="cpu">?</span></span></div>
                <div class="mbox">
                    <div class="mring" style="background:${pressureArc}">
                        <div class="mring-inner" style="background:${zoneRing}">
                            <div class="c"><span class="k" style="color:var(--text);font-size:10px">Pressure</span><span class="n" style="font-size:1.9rem;color:var(--text)">${p ? pr.toFixed(0) : '—'}<span style="font-size:0.9rem">%</span></span></div>
                        </div>
                    </div>
                    <div class="mbd">
                        ${utilRow}
                        <div class="it"><span class="nm">Load</span><span class="v">${load1.toFixed(1)} / ${cores}<span style="font-size:15px;font-weight:700;color:var(--label);margin-left:4px">cores</span></span></div>
                        ${thresholds}
                    </div>
                </div>
            </div>`;
        }

        function renderMem(mem, cpu) {
            const c = document.getElementById('content');

            // save scroll position and expanded group scroll before re-render
            const pageScrollY = window.scrollY;
            const detailScrolls = {};
            document.querySelectorAll('.expanded .details-enter').forEach(el => {
                const key = el.closest('[data-group]')?.dataset.group;
                if(key) detailScrolls[key] = el.scrollTop;
            });

            c.innerHTML = `
                <div class="msplit">${memHeroCard(mem)}${cpuHeroCard(cpu)}</div>
                <div class="grid gap-3">
                    ${mem.process_groups.map(g => {
                        const expandable = g.procs && g.procs.length > 0;
                        const ex = expandable && expandedGroups.has(g.name);
                        const safeKey = g.name.replace(/"/g, '&quot;');
                        const synthetic = g.synthetic === true;
                        return `<div class="card rounded-2xl ${ex ? 'expanded ring-1 ring-[var(--accent)]' : ''}" data-group="${safeKey}" ${synthetic ? 'style="opacity:.82"' : ''}>
                            <div class="px-6 py-4 grid grid-cols-12 items-center ${expandable ? 'cursor-pointer' : ''}" ${expandable ? `onclick="toggleGroup('${g.name.replace(/'/g,"\\'")}')"` : ''}>
                                <div class="col-span-5 flex items-center gap-3">
                                    ${expandable
                                        ? `<svg class="w-4 h-4 transition-transform ${ex ? 'rotate-90' : ''}" fill="currentColor" viewBox="0 0 20 20"><path d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"/></svg>`
                                        : `<span class="w-4 h-4 inline-block"></span>`}
                                    <p class="font-bold text-xl ${synthetic ? 'opacity-80' : ''}">${g.label || g.name}</p>
                                </div>
                                <div class="col-span-2 text-center text-lg uppercase tracking-widest" style="color:var(--strong)">${g.user}</div>
                                <div class="col-span-2 text-center mono text-lg" style="color:var(--text)">${g.count ? g.count + ' procs' : '—'}</div>
                                <div class="col-span-3 text-right mono flex flex-col justify-center items-end" style="font-variant-numeric:tabular-nums">
                                    ${g.rss ? `<div class="text-sm font-bold" style="color:var(--label)">RSS ${formatMem(g.rss)}</div>` : `<div class="text-sm font-bold" style="visibility:hidden">RSS</div>`}
                                    <div class="text-2xl font-black leading-tight" style="color:var(--accent)">PSS ${formatMem(g.pss)}</div>
                                </div>
                            </div>
                            <div class="details-enter px-6" style="background:var(--proc-detail-bg)">
                                <div class="pb-6 pt-2 space-y-3" style="border-top:1px solid var(--separator)">
                                    ${ex ? g.procs.map(p => `
                                        <div class="flex justify-between items-start gap-4 py-2 px-4 rounded-lg proc-hover">
                                            <div class="flex-1 min-w-0">
                                                <div class="flex items-center gap-3 mb-1">
                                                    <span style="display:inline-block;width:6.5rem;flex-shrink:0"><span class="mono text-xs px-2 py-0.5 rounded font-bold pid-badge whitespace-nowrap" style="color:var(--accent)">PID ${p.pid}</span></span>
                                                    <code class="text-xs break-all leading-relaxed min-w-0" style="color:var(--label)">${trimCmd(p.cmd)}</code>
                                                </div>
                                            </div>
                                            <div class="mono text-sm font-semibold whitespace-nowrap text-right flex flex-col justify-center flex-shrink-0" style="width:10rem">
                                                <span class="text-xs" style="color:var(--sub)">RSS: ${memProcVal(p.rss)}</span>
                                                <span class="font-bold" style="color:var(--accent)">PSS: ${memProcVal(p.pss)}</span>
                                            </div>
                                        </div>`).join('') : ''}
                                </div>
                            </div>
                        </div>`;
                    }).join('')}
                </div>`;

            // restore page scroll
            window.scrollTo(0, pageScrollY);
            // restore per-group inner scroll
            document.querySelectorAll('.expanded .details-enter').forEach(el => {
                const key = el.closest('[data-group]')?.dataset.group;
                if(key && detailScrolls[key] !== undefined) el.scrollTop = detailScrolls[key];
            });
        }
