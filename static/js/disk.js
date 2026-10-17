        // ── Disk ─────────────────────────────────────────
        let lastDiskData = null;
        let lastDiskFetch = 0;
        let lastDiskRendered = null;
        const DISK_INTERVAL = 30000;

        // drill-down state (backend restricts browsing to /data)
        let diskDrillPath = null;          // kept null: drilling is now inline, not a separate page
        let diskDrillEntries = null;
        let diskDrillLoading = false;
        let diskDrillError = false;

        // inline expandable tree state (survives the 3s re-render so expansion persists)
        let expandedDiskPaths = new Set();  // full paths currently expanded
        let diskChildren = {};              // path -> entries[] | null(error) | undefined(not loaded)
        let diskLoading = new Set();        // paths currently fetching children

        function diskFmtB(b) {
            if(b >= 1e12) return (b/1e12).toFixed(2)+' TB';
            if(b >= 1e9)  return (b/1e9).toFixed(1)+' GB';
            if(b >= 1e6)  return (b/1e6).toFixed(0)+' MB';
            return (b/1e3).toFixed(0)+' KB';
        }

        function diskSizeBar(pct) {
            return `<div style="width:100%;height:6px;background:var(--bar-bg);border-radius:999px;overflow:hidden">
                <div style="width:${pct.toFixed(1)}%;height:100%;background:var(--accent);border-radius:999px"></div>
            </div>`;
        }

        // one size row: icon + truncating name + size, then a bar. clickAttr enables drill.
        function diskRow(name, used, pct, isDir, clickAttr) {
            const icon = isDir ? FOLDER_SVG : FILE_SVG;
            const chevron = (isDir && clickAttr) ? ' <span style="color:var(--sub);font-size:0.85em;flex-shrink:0">›</span>' : '';
            return `<div class="disk-row${clickAttr ? '' : ' disk-row-static'}" ${clickAttr || ''}>
                <div class="flex justify-between items-center gap-3 mb-2">
                    <span class="font-bold text-base flex items-center gap-1.5 min-w-0" style="${isDir ? '' : 'color:var(--label)'}">${icon}<span class="truncate">${escapeHTML(name)}</span>${chevron}</span>
                    <span class="mono font-black text-base flex-shrink-0">${diskFmtB(used)}</span>
                </div>
                ${diskSizeBar(pct)}
            </div>`;
        }

        async function renderDisk() {
            updateClock();
            if(diskDrillPath !== null) { renderDiskDrill(); return; }

            const c = document.getElementById('content');
            // render whatever we already have immediately (no blocking on fetch)
            if(lastDiskData) renderDiskOverview(lastDiskData);
            else c.innerHTML = '<p class="text-sm mono" style="color:var(--sub)">Loading disk usage…</p>';

            const now = Date.now();
            if(!lastDiskData || now - lastDiskFetch > DISK_INTERVAL) {
                try {
                    const res = await fetch(withHost('/api/disk'));
                    if(!res.ok) { if(!lastDiskData) renderHostUnavailable(); return; }
                    const fresh = await res.json();
                    lastDiskData = fresh;
                    lastDiskFetch = now;
                    if(diskDrillPath === null) renderDiskOverview(fresh);
                } catch(e) {
                    if(!lastDiskData) c.innerHTML = '<p style="color:var(--sub)">Failed to load disk info.</p>';
                }
            }
        }

        // capacity header for a mounted filesystem (mount + device + % + bar + used/free/total)
        function diskCapacityHeader(p) {
            return `
                <div class="flex justify-between items-start gap-3">
                    <div class="min-w-0">
                        <p class="font-black text-2xl mono truncate leading-tight">${escapeHTML(p.mountpoint)}</p>
                        <p class="text-xs mono mt-1" style="color:var(--sub)">${escapeHTML(p.device)}</p>
                    </div>
                    <p class="text-4xl font-black mono flex-shrink-0 leading-none" style="color:var(--accent)">${p.percent.toFixed(0)}<span class="text-xl opacity-60">%</span></p>
                </div>
                <div style="width:100%;height:10px;background:var(--bar-bg);border-radius:999px;overflow:hidden;border:1px solid var(--bar-border);margin:14px 0 12px">
                    <div style="width:${p.percent}%;height:100%;background:var(--accent);border-radius:999px"></div>
                </div>
                <div class="flex justify-between mono font-bold text-xs" style="color:var(--label)">
                    <span>USED <strong class="text-base" style="color:var(--strong)">${diskFmtB(p.used)}</strong></span>
                    <span>FREE <strong class="text-base" style="color:var(--accent)">${diskFmtB(p.free)}</strong></span>
                    <span>TOTAL <strong class="text-base" style="color:var(--strong)">${diskFmtB(p.total)}</strong></span>
                </div>`;
        }

        // "Contents" section: divider + inline tree of directory sizes
        function diskContentsSection(basePath, entries, drillable) {
            const body = entries.length
                ? `<div data-disk-scroll="${escapeHTML(basePath)}" style="max-height:560px;overflow-y:auto;overflow-x:hidden;padding-right:4px">${diskTreeRows(entries, basePath, entries.reduce((s,e)=>s+e.used,0), 0, drillable)}</div>`
                : `<p class="text-sm mono py-2" style="color:var(--sub)">Collecting directory sizes…</p>`;
            return `<div class="flex items-center gap-3 mt-7 mb-4">
                    <p class="text-xs font-black uppercase tracking-widest" style="color:var(--sub)">Contents</p>
                    <div class="flex-1" style="height:1px;background:var(--separator)"></div>
                    ${entries.length ? `<p class="text-xs mono" style="color:var(--sub)">${entries.length} items</p>` : ''}
                </div>${body}`;
        }

        // recursive rows; when a drillable folder is expanded, its children render indented below it
        function diskTreeRows(entries, parentPath, totalUsed, depth, drillable) {
            return entries.map(e => {
                const pct = totalUsed > 0 ? (e.used / totalUsed * 100) : 0;
                const full = parentPath.replace(/\/$/,'') + '/' + e.name;
                const isDir = e.is_dir !== false;         // du breakdown entries have no is_dir → dir
                const canExpand = drillable && isDir;
                const expanded = expandedDiskPaths.has(full);
                const loading = diskLoading.has(full);
                let out = diskTreeRow(e, full, pct, canExpand, expanded, loading, depth);
                if(canExpand && expanded) {
                    const kids = diskChildren[full];
                    if(kids === null)            out += diskTreeNote('Failed to read this directory.', depth+1, true);
                    else if(loading && !kids)    out += diskTreeNote('Loading…', depth+1);
                    else if(kids && kids.length) out += diskTreeRows(kids, full, kids.reduce((s,k)=>s+k.used,0), depth+1, true);
                    else if(kids)                out += diskTreeNote('empty', depth+1);
                }
                return out;
            }).join('');
        }

        function diskTreeRow(e, full, pct, canExpand, expanded, loading, depth) {
            const isDir = e.is_dir !== false;
            const icon = isDir ? FOLDER_SVG : FILE_SVG;
            const chevron = canExpand
                ? `<span style="display:inline-block;transition:transform .15s;flex-shrink:0;color:var(--sub);${expanded ? 'transform:rotate(90deg)' : ''}">›</span>`
                : `<span style="display:inline-block;width:0.55em;flex-shrink:0"></span>`;
            const click = canExpand ? `onclick="diskToggle('${escapeHTML(full).replace(/'/g,"\\'")}')"` : '';
            return `<div class="disk-row${canExpand ? '' : ' disk-row-static'}" style="padding-left:${depth*20}px" ${click}>
                <div class="flex justify-between items-center gap-3 mb-2">
                    <span class="font-bold text-base flex items-center gap-1.5 min-w-0" style="${isDir ? '' : 'color:var(--label)'}">${chevron}${icon}<span class="truncate">${escapeHTML(e.name)}</span>${loading ? ' <span class="text-xs" style="color:var(--sub)">…</span>' : ''}</span>
                    <span class="mono font-black text-base flex-shrink-0">${diskFmtB(e.used)}</span>
                </div>
                ${diskSizeBar(pct)}
            </div>`;
        }

        function diskTreeNote(text, depth, isError) {
            return `<div class="disk-row-static" style="padding-left:${depth*20}px"><p class="text-sm mono" style="color:${isError ? 'var(--color-crit)' : 'var(--sub)'}">${escapeHTML(text)}</p></div>`;
        }

        // expand/collapse a folder inline; fetches children on first expand, caches them
        function diskToggle(path) {
            if(expandedDiskPaths.has(path)) { expandedDiskPaths.delete(path); rerenderDisk(); return; }
            expandedDiskPaths.add(path);
            if(diskChildren[path] === undefined && !diskLoading.has(path)) {
                diskLoading.add(path);
                rerenderDisk();
                fetch(withHost('/api/disk/dir?path=' + encodeURIComponent(path)))
                    .then(r => r.ok ? r.json() : Promise.reject(r))
                    .then(d => { diskChildren[path] = d.entries || []; })
                    .catch(() => { diskChildren[path] = null; })
                    .finally(() => { diskLoading.delete(path); rerenderDisk(); });
            } else {
                rerenderDisk();
            }
        }
        function rerenderDisk() { lastDiskRendered = null; if(lastDiskData) renderDiskOverview(lastDiskData); }

        function renderDiskOverview(data) {
            const partitions = data.partitions || [];
            const subdirs    = data.subdirs || {};
            const norm = s => s.replace(/\/$/,'');
            const drillRoots = (data.drill_roots || ['/data']).map(norm);
            const partMounts = new Set(partitions.map(p => norm(p.mountpoint)));

            // coarse key: skip re-render on sub-0.1% usage jitter, but rebuild on real
            // change or when the user expands/collapses a folder (tree survives either way).
            const key = JSON.stringify({
                p: partitions.map(p => [p.mountpoint, p.device, p.total, Math.round(p.percent*10)]),
                s: Object.fromEntries(Object.entries(subdirs).map(([k,v]) => [k, v.map(e => [e.name, e.used])])),
                x: [...expandedDiskPaths].sort(),
            });
            if(lastDiskRendered === key) return;
            lastDiskRendered = key;

            const c = document.getElementById('content');
            const scrollY = window.scrollY;
            // preserve each tree's inner scroll — the folder list scrolls inside a
            // fixed-height box, so a re-render (toggle/refresh) would otherwise snap
            // it back to the top.
            const treeScroll = {};
            c.querySelectorAll('[data-disk-scroll]').forEach(el => { treeScroll[el.getAttribute('data-disk-scroll')] = el.scrollTop; });
            const cards = [];

            // 1) mounted filesystems → capacity card; drill roots get their tree inline
            partitions.forEach(p => {
                const root = norm(p.mountpoint);
                if(drillRoots.includes(root)) {
                    const entries = subdirs[root] || subdirs[p.mountpoint] || [];
                    cards.push(`<div class="card p-8 rounded-2xl">${diskCapacityHeader(p)}${diskContentsSection(root, entries, true)}</div>`);
                } else {
                    cards.push(`<div class="card p-8 rounded-2xl">${diskCapacityHeader(p)}</div>`);
                }
            });

            // 2) directory-usage roots that are NOT their own filesystem (e.g. /home under /)
            Object.keys(subdirs).forEach(base => {
                if(partMounts.has(norm(base))) return;   // already a partition card above
                const entries = subdirs[base] || [];
                const total = entries.reduce((s, e) => s + e.used, 0);
                cards.push(`<div class="card p-8 rounded-2xl">
                    <div class="flex justify-between items-start gap-3">
                        <div class="min-w-0">
                            <p class="font-black text-2xl mono truncate leading-tight">${escapeHTML(base)}</p>
                            <p class="text-xs mono mt-1" style="color:var(--sub)">directory usage</p>
                        </div>
                        <p class="text-2xl font-black mono flex-shrink-0" style="color:var(--strong)">${diskFmtB(total)}</p>
                    </div>
                    ${diskContentsSection(norm(base), entries, drillRoots.includes(norm(base)))}
                </div>`);
            });

            c.innerHTML = `
                <p class="text-2xl font-black tracking-tight mb-4">Disk Usage</p>
                ${cards.length
                    ? `<div class="grid gap-4">${cards.join('')}</div>`
                    : `<div class="card p-6 rounded-2xl opacity-40"><p class="font-bold text-sm mono">No disks found.</p></div>`}`;
            requestAnimationFrame(() => {
                window.scrollTo(0, scrollY);
                c.querySelectorAll('[data-disk-scroll]').forEach(el => {
                    const k = el.getAttribute('data-disk-scroll');
                    if(treeScroll[k] != null) el.scrollTop = treeScroll[k];
                });
            });
        }

        function renderDiskDrill() {
            const c = document.getElementById('content');

            // figure out which drill root this path belongs to (longest match)
            const roots = ((lastDiskData && lastDiskData.drill_roots) || ['/data']).map(r => r.replace(/\/$/,''));
            const root = roots.filter(r => diskDrillPath === r || diskDrillPath.startsWith(r + '/'))
                              .sort((a, b) => b.length - a.length)[0] || '/data';
            const rel = diskDrillPath.slice(root.length).replace(/^\//, '');
            const segs = rel ? rel.split('/') : [];
            const crumbs = [
                `<span onclick="diskDrill('${escapeHTML(root).replace(/'/g,"\\'")}')" style="cursor:pointer;${segs.length===0 ? 'color:var(--accent);font-weight:800' : 'color:var(--label)'}">${escapeHTML(root)}</span>`
            ];
            let acc = root;
            segs.forEach((s, i) => {
                acc += '/' + s;
                const isLast = i === segs.length - 1;
                crumbs.push(`<span style="color:var(--sub)">/</span>`);
                crumbs.push(isLast
                    ? `<span style="color:var(--accent);font-weight:800;word-break:break-all">${escapeHTML(s)}</span>`
                    : `<span onclick="diskDrill('${escapeHTML(acc).replace(/'/g,"\\'")}')" style="cursor:pointer;color:var(--label);word-break:break-all">${escapeHTML(s)}</span>`);
            });

            let body;
            if(diskDrillLoading) {
                body = `<div class="card p-8 rounded-2xl opacity-60"><p class="mono text-sm" style="word-break:break-all">Scanning <strong>${escapeHTML(diskDrillPath)}</strong> … large directories can take a while.</p></div>`;
            } else if(diskDrillError) {
                body = `<div class="card p-8 rounded-2xl"><p class="text-sm" style="color:var(--color-crit)">Failed to read this directory.</p></div>`;
            } else {
                const entries = diskDrillEntries || [];
                if(entries.length === 0) {
                    body = `<div class="card p-8 rounded-2xl opacity-50"><p class="text-sm">Nothing here over the size threshold.</p></div>`;
                } else {
                    const total = entries.reduce((s, e) => s + e.used, 0);
                    const rows = entries.map(e => {
                        const pct = total > 0 ? (e.used / total * 100) : 0;
                        const full = diskDrillPath.replace(/\/$/,'') + '/' + e.name;
                        const click = e.is_dir ? `onclick="diskDrill('${escapeHTML(full).replace(/'/g,"\\'")}')"` : '';
                        return diskRow(e.name, e.used, pct, e.is_dir, click);
                    }).join('');
                    body = `<div class="card p-8 rounded-2xl"><div style="max-height:640px;overflow-y:auto;overflow-x:hidden;padding-right:4px">${rows}</div></div>`;
                }
            }

            c.innerHTML = `
                <div class="flex items-center gap-3 mb-6 flex-wrap">
                    <button onclick="diskDrill(null)" class="modal-btn modal-btn-ghost" style="font-size:12px;padding:6px 14px;flex-shrink:0">← Disk Usage</button>
                    <p class="text-lg mono font-bold flex flex-wrap items-center gap-1" style="min-width:0">${crumbs.join('')}</p>
                </div>
                ${body}`;
        }

        function diskDrill(path) {
            diskDrillError = false;
            diskDrillPath = path;
            if(path === null) { lastDiskRendered = null; renderDisk(); return; }  // back to overview
            diskDrillEntries = null;
            diskDrillLoading = true;
            renderDiskDrill();  // show loading immediately
            fetch(withHost('/api/disk/dir?path=' + encodeURIComponent(path)))
                .then(r => r.ok ? r.json() : Promise.reject(r))
                .then(d => {
                    if(diskDrillPath !== path) return;  // user navigated away
                    diskDrillEntries = d.entries;
                    diskDrillLoading = false;
                    renderDiskDrill();
                })
                .catch(() => {
                    if(diskDrillPath !== path) return;
                    diskDrillLoading = false;
                    diskDrillError = true;
                    renderDiskDrill();
                });
        }
