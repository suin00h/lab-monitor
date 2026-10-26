        let currentTab = 'gpu';
        let currentHost = 'local';   // multi-host: which server's metrics to show
        let hostList = [];           // [{id,name,local,online,age,...}] from /api/hosts
        let expandedGroups = new Set();

        // pull the configurable site title (config.json → site_title) into the page
        (async () => {
            try {
                const r = await fetch('/api/config');
                if(r.ok) {
                    const { site_title } = await r.json();
                    if(site_title) {
                        document.title = site_title;
                        const t = document.getElementById('app-title');
                        if(t) t.textContent = site_title;
                    }
                }
            } catch(e) {}
        })();

        function setAccent(color) {
            document.documentElement.style.setProperty('--accent', color);
            localStorage.setItem('lab-accent', color);
            // highlight the active swatch; if no preset matches, it's a custom color
            let matched = false;
            document.querySelectorAll('.color-dot[data-accent]').forEach(el => {
                const m = el.dataset.accent.toLowerCase() === String(color).toLowerCase();
                matched = matched || m;
                el.classList.toggle('accent-active', m);
            });
            const pk = document.getElementById('accent-picker');
            if(pk) {
                if(/^#[0-9a-fA-F]{6}$/.test(color)) pk.value = color;
                pk.classList.toggle('accent-active', !matched);
            }
        }
        // single toggle button shows the CURRENT mode (moon = dark, sun = light);
        // clicking flips it. One click target instead of a split Light|Dark pair.
        const MOON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
        const SUN_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0-6h0v3m0 16v3m9-11h3M1 12h3m14.5-6.5 2-2M3.5 20.5l2-2m0-13-2-2m15 15 2 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><circle cx="12" cy="12" r="4"/></svg>';
        function setTheme(mode) {
            const dark = mode !== 'light';
            document.documentElement.classList.toggle('dark', dark);
            document.documentElement.classList.toggle('light', !dark);
            localStorage.setItem('lab-theme', dark ? 'dark' : 'light');
            const btn = document.getElementById('theme-toggle');
            if(btn) btn.innerHTML = dark ? MOON_SVG : SUN_SVG;
        }
        function toggleTheme() {  // kept for any external callers
            setTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark');
        }
        setAccent(localStorage.getItem('lab-accent') || '#5b6af0');
        setTheme(localStorage.getItem('lab-theme') || 'dark');

        function switchTab(tab) {
            currentTab = tab;
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.getElementById('btn-' + tab).classList.add('active');
            if(tab === 'disk') {
                // force fetch on tab switch so partition info shows immediately
                diskDrillPath = null;
                lastDiskFetch = 0;
                lastDiskRendered = null;
                renderDisk();
            }
            else if(tab === 'docker') { lastDockerRendered = null; renderDocker(); }
            else update();
        }

        function toggleGroup(name) {
            if(expandedGroups.has(name)) expandedGroups.delete(name);
            else expandedGroups.add(name);
            update();
        }

        function formatMem(mib) {
            if(mib >= 1024) return (mib/1024).toFixed(1) + ' GiB';
            return Math.round(mib) + ' MiB';
        }

        function escapeHTML(str) {
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#x27;');
        }

        function trimCmd(cmd) {
            cmd = cmd.replace(/(--connection-token(?:-file)?)\s+\S+/g, '$1 [hidden]');
            cmd = cmd.replace(/\/home\/\w+\/\.vscode-server\/(?:cli\/servers\/Stable-[a-f0-9]+\/server\/)?/g, '[vsc]/');
            cmd = cmd.replace(/\/root\/\.vscode-server\/(?:cli\/servers\/Stable-[a-f0-9]+\/server\/)?/g, '[vsc]/');
            cmd = cmd.replace(/\s+--extensions-download-dir\s+\S+/g, '');
            cmd = cmd.replace(/(--log(?:sPath)?)\s+\S+/g, '$1 [path]');
            cmd = cmd.replace(/(--socket-path)\s+\S+/g, '$1 [path]');
            cmd = cmd.replace(/(--cancellationReceive=file:)\S+/g, '$1[path]');
            return cmd;
        }

        function updateClock() {
            const now = new Date();
            let h = now.getHours();
            const m = String(now.getMinutes()).padStart(2,'0');
            const s = String(now.getSeconds()).padStart(2,'0');
            const ap = h >= 12 ? 'PM' : 'AM';
            h = h % 12; h = h ? h : 12;
            document.getElementById('time').innerText = `${String(h).padStart(2,'0')}:${m}:${s} ${ap}`;
        }

        // append the active host to an API path (local is the implicit default)
        function withHost(url, host) {
            return url + (url.includes('?') ? '&' : '?') + 'host=' + encodeURIComponent(host || currentHost);
        }

        function renderHostUnavailable(msg) {
            const c = document.getElementById('content');
            const host = hostList.find(h => h.id === currentHost);
            c.innerHTML = `<div class="card rounded-2xl p-8 opacity-70">
                <p class="font-black text-lg mb-1">${escapeHTML(host ? host.name : currentHost)} <span style="color:var(--sub)">· Offline</span></p>
                <p class="text-sm mono" style="color:var(--sub)">${escapeHTML(msg || 'No data received from this host yet.')}</p>
            </div>`;
        }

        async function update() {
            // Pin the host at request start; if the user switches away mid-flight,
            // drop the stale response so it can't render (or pollute the per-host GPU
            // colour seats) under the wrong host.
            const reqHost = currentHost;
            try {
                const metric = currentTab === 'gpu' ? 'gpu' : 'memory';
                const res = await fetch(withHost('/api/' + metric, reqHost));
                if(currentHost !== reqHost) return;
                updateClock();
                if(!res.ok) { renderHostUnavailable(); return; }
                const data = await res.json();
                if(currentHost !== reqHost) return;
                if(currentTab === 'gpu') {
                    // thin vitals strip above the cards: memory use + CPU pressure (best-effort)
                    let mem = null, cpu = null, notes = {};
                    const [mr, cr, nr] = await Promise.all([
                        fetch(withHost('/api/memory', reqHost)).catch(() => null),
                        fetch(withHost('/api/cpu', reqHost)).catch(() => null),
                        fetch('/api/gpu_notes').catch(() => null),   // central notes, not per-host
                    ]);
                    try { if(mr && mr.ok) mem = await mr.json(); } catch(e) {}
                    try { if(cr && cr.ok) cpu = await cr.json(); } catch(e) {}
                    try { if(nr && nr.ok) notes = await nr.json(); } catch(e) {}
                    if(currentHost !== reqHost) return;
                    // don't rebuild the cards while the pointer is on a block — it
                    // would destroy the hovered node and flicker. Resumes on mouse-out.
                    if(window._overVramBlock) return;
                    renderGpu(data, 'content', mem, cpu, notes);
                }
                else {
                    // memory tab also shows a CPU load/contention card (best-effort)
                    let cpu = null;
                    try { const cr = await fetch(withHost('/api/cpu', reqHost)); if(cr.ok) cpu = await cr.json(); } catch(e) {}
                    if(currentHost !== reqHost) return;
                    renderMem(data, cpu);
                }
            } catch(e) { console.error("Fetch failed", e); }
        }

        async function loadHosts() {
            if(window._devPreview) return;  // don't overwrite the Dev multi-host preview
            try {
                const res = await fetch('/api/hosts');
                hostList = (await res.json()).hosts || [];
            } catch(e) { hostList = [{id:'local', name:'monitor', local:true, online:true}]; }
            renderHostSelector();
        }

        function renderHostSelector() {
            const bar = document.getElementById('host-bar');
            const box = document.getElementById('host-chips');
            if(!bar || !box) return;
            if(!hostList.length) { bar.style.display = 'none'; return; }
            bar.style.display = 'flex';   // always visible, even with only the local host
            // keep currentHost valid — this reset must run in the single-host case too
            if(!hostList.some(h => h.id === currentHost)) currentHost = 'local';
            box.innerHTML = hostList.map(h => {
                const active = h.id === currentHost;
                const offline = !h.local && !h.online;  // local is always reachable; only remotes can be down
                // offline remotes are dimmed and non-selectable (disabled); the
                // reason shows on hover via the title rather than an inline tag.
                return `<button ${offline ? 'disabled' : `onclick="switchHost('${String(h.id).replace(/'/g,"\\'")}')"`}
                    class="host-chip${active?' host-chip-active':''}${offline?' host-chip-off':''}" title="${escapeHTML(h.name)}${offline?' · Offline':''}">
                    <span>${escapeHTML(h.name)}</span></button>`;
            }).join('');
        }

        function switchHost(id) {
            currentHost = id;
            renderHostSelector();   // reflect the active chip immediately
            if(currentTab === 'gpu' || currentTab === 'mem') update();
            else if(currentTab === 'disk') {
                diskDrillPath = null; lastDiskFetch = 0; lastDiskRendered = null; renderDisk();
            }
            else if(currentTab === 'docker') {
                lastDockerData = null; lastDockerFetch = 0; lastDockerRendered = null; renderDocker();
            }
        }

        // Rich hover feed tooltip for VRAM blocks (body-level, escapes overflow):
        // a process-name header (needed for tiny blocks with no inline text) then
        // one icon+comment line each, stacked vertically.
        const noteTip = document.createElement('div');
        noteTip.className = 'note-tip';
        document.body.appendChild(noteTip);
        document.addEventListener('mousemove', e => {
            const block = e.target.closest('.vram-block');
            // pause the 3s GPU re-render while the pointer rests on a block, so the
            // hovered node isn't torn down and rebuilt under the cursor (flicker).
            window._overVramBlock = !!block;
            if(!block || !block.dataset.pid) { noteTip.classList.remove('show'); return; }
            const key = currentHost + ':' + block.dataset.gpu + ':' + block.dataset.pid;
            const comments = (window._gpuNotes && window._gpuNotes[key]) || [];
            const small = block.dataset.small === '1';
            if(!comments.length && !small) { noteTip.classList.remove('show'); return; }
            const sig = key + '|' + comments.map(c => c.id).join(',');
            if(noteTip.dataset.sig !== sig) {
                let html = '<div class="nt-head">' + block.dataset.user + (small ? ' · ' + block.dataset.usage : '') + '</div>';
                if(comments.length) html += '<div class="nt-list">' + comments.map(c =>
                    '<div class="nt-row"><span class="nt-ico" style="color:' + authorColor(c.author) + '">' + authorIcon(c.author) + '</span><span class="nt-t">' + escapeHTML(c.text) + '</span></div>').join('') + '</div>';
                noteTip.innerHTML = html;
                noteTip.dataset.sig = sig;
            }
            noteTip.style.left = Math.min(e.clientX + 14, window.innerWidth - 312) + 'px';
            noteTip.style.top = (e.clientY + 16) + 'px';
            noteTip.classList.add('show');
        });

        // Shared body-level help tooltip (the circled "?" badges). Body-level so the
        // 3s card re-render can't destroy/recreate it mid-hover (that caused flicker).
        // Anchored under the badge; stays open while the pointer is on badge or tip.
        const helpTip = document.createElement('div');
        helpTip.className = 'help-tooltip';
        document.body.appendChild(helpTip);
        let _helpHideT = null;
        let _helpPinned = false;   // click a help "?" / Owners trigger to pin the panel open
        const _unpinHelp = () => { _helpPinned = false; helpTip.classList.remove('pinned', 'show'); helpTip.dataset.key = ''; };
        document.addEventListener('mousemove', e => {
            if(_helpPinned) return;  // frozen while pinned — click-out or re-click to release
            const badge = e.target.closest('.help, .gpu-owners, .gpu-comment');
            const overTip = helpTip.contains(e.target);
            if(badge || overTip) {
                clearTimeout(_helpHideT); _helpHideT = null;
                if(badge) {
                    const html = badge.dataset.helpHtml;  // inline payload (GPU owners); else HELP_TIPS lookup
                    // key includes the payload so a changed owner list re-renders.
                    const key = html ? ('h:' + html) : badge.dataset.help;
                    if(helpTip.dataset.key !== key) {
                        helpTip.innerHTML = html ? html : ((typeof HELP_TIPS !== 'undefined' && HELP_TIPS[badge.dataset.help]) || '');
                        helpTip.dataset.key = key;
                    }
                    const r = badge.getBoundingClientRect(), w = 300;
                    // ?-badges sit on the right → right-align under them; the owners
                    // trigger sits on the left → left-align so the panel tracks it.
                    helpTip.style.left = (html
                        ? Math.max(8, Math.min(r.left, window.innerWidth - w - 8))
                        : Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))) + 'px';
                    // Strongly prefer opening DOWNWARD so the panel never covers the
                    // card you're reading. Only flip up when there's too little room
                    // below to be usable (near the viewport bottom); the max-height
                    // clamp then lets a long list scroll instead of spilling off-screen.
                    const spaceBelow = window.innerHeight - r.bottom - 16;
                    const spaceAbove = r.top - 16;
                    if(spaceBelow >= 180 || spaceBelow >= spaceAbove) {
                        helpTip.style.top = (r.bottom + 9) + 'px';
                        helpTip.style.bottom = 'auto';
                        helpTip.style.maxHeight = Math.max(80, spaceBelow) + 'px';
                    } else {
                        helpTip.style.top = 'auto';
                        helpTip.style.bottom = (window.innerHeight - r.top + 9) + 'px';
                        helpTip.style.maxHeight = Math.max(80, spaceAbove) + 'px';
                    }
                }
                helpTip.classList.add('show');
            } else if(helpTip.classList.contains('show') && !_helpHideT) {
                // debounce: tolerate the gap between badge and tooltip without flicker
                _helpHideT = setTimeout(() => { helpTip.classList.remove('show'); _helpHideT = null; }, 140);
            }
        });
        // Click a help "?" or the Owners trigger to PIN the panel open — so a long
        // owner list can be read (and scrolled) without holding the hover. Click the
        // trigger again, or anywhere outside, to release it.
        document.addEventListener('click', e => {
            const badge = e.target.closest('.help, .gpu-owners');
            if(!badge) return;
            if(_helpPinned) { _unpinHelp(); return; }
            if(helpTip.classList.contains('show')) { _helpPinned = true; helpTip.classList.add('pinned'); }
        });
        document.addEventListener('mousedown', e => {
            if(_helpPinned && !helpTip.contains(e.target) && !e.target.closest('.help, .gpu-owners')) _unpinHelp();
        });
        // Safety: never leave the GPU board frozen if the pointer leaves the window or
        // the tab loses focus while resting on a block (mousemove wouldn't fire again).
        document.addEventListener('mouseleave', () => { window._overVramBlock = false; });
        window.addEventListener('blur', () => { window._overVramBlock = false; });
        document.addEventListener('visibilitychange', () => {
            if(document.hidden) { window._overVramBlock = false; }
            else { updateClock(); if(currentTab==='gpu'||currentTab==='mem') update(); }  // refresh immediately on return
        });

        // ── GPU per-process note editor (shared popover) ──
        // Notes are keyed host:gpu:pid and stored centrally. window._gpuNotes holds
        // the latest fetched map so the editor can prefill the current text.
        // ── GPU process comment feed (click a block → popup; shared, per-browser id) ──
        window._gpuNotes = {};  // {key: [ {id, author, text, ts} ]}
        let _noteCtx = null;
        let _uid = 'anon';
        try { _uid = localStorage.getItem('lab-uid') || ('u' + Math.random().toString(36).slice(2, 10)); localStorage.setItem('lab-uid', _uid); } catch(e) {}
        const CLOSE_SVG = '<svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor"><path d="M5.3 5.3a1 1 0 011.4 0L10 8.6l3.3-3.3a1 1 0 011.4 1.4L11.4 10l3.3 3.3a1 1 0 01-1.4 1.4L10 11.4l-3.3 3.3a1 1 0 01-1.4-1.4L8.6 10 5.3 6.7a1 1 0 010-1.4z"/></svg>';
        const notePop = document.createElement('div');
        notePop.className = 'gpu-note-pop';
        notePop.innerHTML =
            '<div class="gnp-head"><span class="gnp-title"></span><button class="gnp-x" title="Close">' + CLOSE_SVG + '</button></div>'
            + '<div class="gnp-feed"></div>'
            + '<div class="gnp-compose"><input class="gnp-input" maxlength="200" placeholder="e.g. done in ~1h"><button class="gnp-send modal-btn modal-btn-primary">Send</button></div>';
        document.body.appendChild(notePop);
        const _noteFeed = notePop.querySelector('.gnp-feed');
        const _noteInput = notePop.querySelector('.gnp-input');
        function _noteKey() { return _noteCtx ? (currentHost + ':' + _noteCtx.gpu + ':' + _noteCtx.pid) : null; }
        function renderNoteFeed() {
            const key = _noteKey(); if(!key) return;
            const comments = window._gpuNotes[key] || [];
            if(!comments.length) { _noteFeed.innerHTML = '<div class="gnp-empty">No comments yet.</div>'; return; }
            _noteFeed.innerHTML = comments.map(c =>
                '<div class="gnp-c"><span class="gnp-c-ico" style="color:' + authorColor(c.author) + '">' + authorIcon(c.author) + '</span>'
                + '<div class="gnp-c-body"><div class="gnp-c-text">' + escapeHTML(c.text) + '</div>'
                + '<div class="gnp-c-meta">' + gpuTimeAgo(c.ts) + ' · <span class="gnp-c-del" data-id="' + c.id + '">Delete</span></div></div></div>'
            ).join('');
            _noteFeed.scrollTop = _noteFeed.scrollHeight;
        }
        function gpuNoteEdit(gpuId, pid, user) {
            _noteCtx = { gpu: String(gpuId), pid: String(pid) };
            notePop.querySelector('.gnp-title').textContent = user || 'process';
            renderNoteFeed();
            notePop.classList.add('show');
            _noteInput.value = '';
            _noteInput.focus();
        }
        function gpuNoteClose() { notePop.classList.remove('show'); _noteCtx = null; }
        async function _notePost(payload) {
            const key = _noteKey(); if(!key) return;
            const body = Object.assign({ host: currentHost, gpu: _noteCtx.gpu, pid: _noteCtx.pid, author: _uid }, payload);
            try {
                const r = await fetch('/api/gpu_notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                if(r.ok) { const d = await r.json(); window._gpuNotes[key] = d.comments || []; renderNoteFeed(); if(currentTab === 'gpu') update(); }
            } catch(e) {}
        }
        function _noteSend() { const t = _noteInput.value.trim(); if(!t) return; _noteInput.value = ''; _notePost({ text: t }); }
        notePop.querySelector('.gnp-send').onclick = _noteSend;
        notePop.querySelector('.gnp-x').onclick = gpuNoteClose;
        _noteInput.addEventListener('keydown', e => { if(e.key === 'Enter') _noteSend(); else if(e.key === 'Escape') gpuNoteClose(); });
        _noteFeed.addEventListener('click', e => { const del = e.target.closest('.gnp-c-del'); if(del) _notePost({ action: 'delete', id: del.dataset.id }); });
        document.addEventListener('mousedown', e => {
            if(notePop.classList.contains('show') && !notePop.contains(e.target) && !e.target.closest('[data-note-trigger]')) gpuNoteClose();
        });

        let _hostTick = 0;
        setInterval(()=>{
            if(document.hidden) return;  // a backgrounded tab shouldn't poll/re-render for nobody
            if(currentTab==='gpu'||currentTab==='mem') update();
            else if(currentTab==='disk' && diskDrillPath === null) {
                // only auto-refresh the overview; don't disturb a drill-down view
                const hasSubdirs = lastDiskData && Object.keys(lastDiskData.subdirs||{}).length > 0;
                if(!hasSubdirs) lastDiskFetch = 0; // force re-fetch until subdirs ready
                renderDisk();
            }
            else if(currentTab==='docker') renderDocker();
            if(++_hostTick % 2 === 0) loadHosts();  // refresh host freshness every ~6s
        }, 3000);
        // the clock ticks every second on its own, re-aligned to each real second boundary
        (function tickClock(){
            if(!document.hidden) updateClock();
            setTimeout(tickClock, 1000 - (Date.now() % 1000) + 5);
        })();
        loadHosts();
        update();
