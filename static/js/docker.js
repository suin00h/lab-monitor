        // ── Docker ───────────────────────────────────────
        let lastDockerData = null;
        let lastDockerFetch = 0;
        let lastDockerHost = null;
        let lastDockerRendered = null;
        const DOCKER_INTERVAL = 15000;

        // Images: show the 5 biggest, fold the rest. Remember the open state so the
        // 15s refresh (and dedupe re-render) doesn't snap it shut mid-read.
        const DOCKER_IMG_TOP = 5, DOCKER_CT_TOP = 5;
        let dockerImagesOpen = false, dockerContainersOpen = false;
        function dockerImagesToggle(open) { dockerImagesOpen = open; }
        function dockerContainersToggle(open) { dockerContainersOpen = open; }
        const DOCKER_CHEV = '<svg class="more-chev" viewBox="0 0 20 20" width="13" height="13" fill="currentColor"><path d="M5.3 7.3a1 1 0 011.4 0L10 10.6l3.3-3.3a1 1 0 011.4 1.4l-4 4a1 1 0 01-1.4 0l-4-4a1 1 0 010-1.4z"/></svg>';

        // The One Light Rule: the accent marks what is *live*. A running
        // container is live → accent; everything stopped recedes to muted grey.
        // (Exited(0) is a clean stop, not an error — so stopped is quiet, not red.)
        function dockerStateColor(state) {
            return state === 'running' ? 'var(--accent)' : 'var(--sub)';
        }

        async function renderDocker() {
            updateClock();
            const c = document.getElementById('content');
            if(lastDockerData && lastDockerHost === currentHost) renderDockerView(lastDockerData);
            else { c.innerHTML = '<p class="text-sm mono" style="color:var(--sub)">Loading docker status…</p>'; lastDockerData = null; lastDockerRendered = null; }

            const now = Date.now();
            if(!lastDockerData || lastDockerHost !== currentHost || now - lastDockerFetch > DOCKER_INTERVAL) {
                try {
                    const res = await fetch(withHost('/api/docker'));
                    if(!res.ok) { if(!lastDockerData) renderHostUnavailable(); return; }
                    const fresh = await res.json();
                    lastDockerData = fresh;
                    lastDockerFetch = now;
                    lastDockerHost = currentHost;
                    if(currentTab === 'docker') renderDockerView(fresh);
                } catch(e) {
                    if(!lastDockerData) c.innerHTML = '<p style="color:var(--sub)">Failed to load docker status.</p>';
                }
            }
        }

        // Section heading on the page background (card holds only the list) — the
        // same treatment as the GPU tab's device headers, so Docker reads as part
        // of the same room instead of a boxed-in panel.
        function dockerSectionHead(title, meta) {
            return `<div class="flex items-baseline justify-between gap-3 mb-4 px-1">
                <span class="text-2xl font-black tracking-tight">${title}</span>
                <span class="mono text-sm font-bold tracking-wider uppercase" style="color:var(--label);font-variant-numeric:tabular-nums">${meta}</span>
            </div>`;
        }

        function renderDockerView(data) {
            const c = document.getElementById('content');

            if(!data.available) {
                lastDockerRendered = 'unavailable';
                c.innerHTML = `
                    <div class="card p-8 rounded-2xl opacity-70">
                        <p class="font-black text-lg mb-1">Docker unavailable</p>
                        <p class="text-sm mono" style="color:var(--sub)">${escapeHTML(data.error || 'The docker daemon is not reachable on this host.')}</p>
                    </div>`;
                return;
            }

            const containers = data.containers || [];
            const images = data.images || [];
            const counts = data.counts || {};

            // coarse dedupe: only rebuild on a real change (avoids scroll jump on the 3s tick)
            const key = JSON.stringify({
                c: containers.map(c => [c.name, c.state, c.status]),
                i: images.map(im => [im.repository, im.tag, im.size]),
            });
            if(lastDockerRendered === key) return;
            lastDockerRendered = key;

            const scrollY = window.scrollY;
            const maxImg = images.reduce((m, im) => Math.max(m, im.size_bytes), 0) || 1;

            // ── containers (running first; top 5 shown, rest folded) ──
            const ctSorted = [...containers].sort((a, b) => (b.state === 'running') - (a.state === 'running'));
            const containerRow = (ct, i) => {
                const col = dockerStateColor(ct.state);
                const live = ct.state === 'running';
                const statusCol = live ? 'var(--accent)' : 'var(--label)';
                return `<div class="flex items-center gap-4 py-4 docker-row" style="${i > 0 ? 'border-top:1px solid var(--separator)' : ''}">
                    <span class="flex-shrink-0" style="width:10px;height:10px;border-radius:999px;background:${col}"></span>
                    <div class="min-w-0 flex-1">
                        <p class="font-bold text-base truncate">${escapeHTML(ct.name)}</p>
                        <p class="text-sm mono truncate" style="color:var(--label)">${escapeHTML(ct.image)}${ct.ports ? ' · ' + escapeHTML(ct.ports) : ''}</p>
                    </div>
                    <div class="text-right flex-shrink-0" style="max-width:42%">
                        <p class="mono text-sm font-bold truncate" style="color:${statusCol}">${escapeHTML(ct.status)}</p>
                        <p class="text-sm mt-0.5" style="color:var(--label)">created ${escapeHTML(ct.created)}</p>
                    </div>
                </div>`;
            };
            let containerRows;
            if(!ctSorted.length) {
                containerRows = `<p class="text-sm mono py-4" style="color:var(--sub)">No containers.</p>`;
            } else {
                const head = ctSorted.slice(0, DOCKER_CT_TOP).map((ct, i) => containerRow(ct, i)).join('');
                const rest = ctSorted.slice(DOCKER_CT_TOP);
                const fold = rest.length
                    ? `<details class="docker-more"${dockerContainersOpen ? ' open' : ''} ontoggle="dockerContainersToggle(this.open)"><summary>${DOCKER_CHEV}<span class="lbl-more">Show ${rest.length} more</span><span class="lbl-less">Show less</span></summary>${rest.map((ct, idx) => containerRow(ct, idx + DOCKER_CT_TOP)).join('')}</details>`
                    : '';
                containerRows = head + fold;
            }

            const containersSection = `<div class="mb-10">
                ${dockerSectionHead('Containers', `<strong style="color:var(--accent)">${counts.running || 0}</strong> running · ${counts.containers || 0} total`)}
                <div class="card px-6 py-2 rounded-2xl">${containerRows}</div>
            </div>`;

            // ── images (biggest first; top 5 shown, rest folded) ──
            const imgSorted = [...images].sort((a, b) => b.size_bytes - a.size_bytes);
            const imageRow = (im, i) => {
                const pct = im.size_bytes / maxImg * 100;
                const none = im.repository === '<none>';
                return `<div class="py-4 docker-row" style="${i > 0 ? 'border-top:1px solid var(--separator)' : ''}">
                    <div class="flex justify-between items-baseline gap-3 mb-2">
                        <span class="min-w-0 flex items-baseline gap-2">
                            <span class="font-bold text-base truncate" ${none ? 'style="color:var(--sub)"' : ''}>${escapeHTML(im.repository)}<span style="color:var(--sub)">:${escapeHTML(im.tag)}</span></span>
                            <span class="mono text-sm flex-shrink-0" style="color:var(--label)">${escapeHTML(im.id)}</span>
                        </span>
                        <span class="text-right flex-shrink-0">
                            <span class="mono font-black text-base" style="color:var(--accent)">${escapeHTML(im.size)}</span>
                            <span class="text-sm block" style="color:var(--label)">${escapeHTML(im.created)}</span>
                        </span>
                    </div>
                    <div style="width:100%;height:6px;background:var(--bar-bg);border-radius:999px;overflow:hidden">
                        <div style="width:${pct.toFixed(1)}%;height:100%;background:var(--accent);border-radius:999px"></div>
                    </div>
                </div>`;
            };
            let imageRows;
            if(!imgSorted.length) {
                imageRows = `<p class="text-sm mono py-4" style="color:var(--sub)">No images.</p>`;
            } else {
                const head = imgSorted.slice(0, DOCKER_IMG_TOP).map((im, i) => imageRow(im, i)).join('');
                const rest = imgSorted.slice(DOCKER_IMG_TOP);
                const fold = rest.length
                    ? `<details class="docker-more"${dockerImagesOpen ? ' open' : ''} ontoggle="dockerImagesToggle(this.open)"><summary>${DOCKER_CHEV}<span class="lbl-more">Show ${rest.length} more</span><span class="lbl-less">Show less</span></summary>${rest.map((im, idx) => imageRow(im, idx + DOCKER_IMG_TOP)).join('')}</details>`
                    : '';
                imageRows = head + fold;
            }

            const imagesSection = `<div>
                ${dockerSectionHead('Images', `${counts.images || 0} images`)}
                <div class="card px-6 py-2 rounded-2xl">${imageRows}</div>
            </div>`;

            c.innerHTML = containersSection + imagesSection;
            requestAnimationFrame(() => window.scrollTo(0, scrollY));
        }
