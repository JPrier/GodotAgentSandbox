// Browser shell: owns the WebSocket to the bridge server and relays between it and the
// game iframe. Also renders status, console and build-failure overlays for the human.
(() => {
  const project = decodeURIComponent(location.pathname.split('/')[2] || '');
  const $ = (id) => document.getElementById(id);
  const iframe = $('game');
  const logEl = $('log');
  let ws = null;
  let boot = null;
  let currentBuild = null;
  let gameState = 'connecting';
  let bridgeReady = false;
  const waiting = [];        // commands received before the game's bridge was ready
  const inflight = new Map(); // command id -> cmd (to answer locally on reload)

  $('proj').textContent = project;
  document.title = `${project} — Godot Cloud Kit`;

  // ---------------------------------------------------------------- UI helpers
  function setState(s, detail) {
    gameState = s;
    const el = $('state');
    el.dataset.s = s;
    el.textContent = detail ? `${s} · ${detail}` : s;
  }
  function addLog(level, text, source = 'game') {
    const li = document.createElement('li');
    li.className = `lv-${level}`;
    const t = new Date().toLocaleTimeString([], { hour12: false });
    li.innerHTML = `<time>${t}</time><span class="src">${source}</span><span class="txt"></span>`;
    li.querySelector('.txt').textContent = text;
    const stick = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    logEl.appendChild(li);
    while (logEl.children.length > 1500) logEl.firstChild.remove();
    if (stick) logEl.scrollTop = logEl.scrollHeight;
  }
  let toastTimer;
  function toast(text, ms = 2600) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }
  function overlay(html) {
    const el = $('overlay');
    if (!html) { el.hidden = true; el.innerHTML = ''; return; }
    el.innerHTML = html;
    el.hidden = false;
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------------------------------------------------------------- game lifecycle
  function loadBuild(n, pckUrl) {
    if (!boot) return;
    currentBuild = n;
    bridgeReady = false;
    for (const [id, cmd] of inflight) sendWs({ type: 'response', id, ok: false, error: `game reloaded (build ${n}) before ${cmd} finished` });
    inflight.clear();
    $('build').textContent = `build ${n}`;
    setState('loading', `build ${n}`);
    overlay(null);
    const qs = new URLSearchParams({ engine: boot.engine.base, pck: pckUrl, build: String(n), t: Date.now() });
    iframe.src = `/player.html?${qs}`;
    sendWs({ type: 'status', state: 'loading', build: n });
  }

  async function showBuildFailure(n) {
    try {
      const rec = await api(`/api/projects/${project}/builds/${n}`);
      const v = rec.steps?.validate;
      const items = [];
      for (const f of v?.failures || []) items.push(`<li><b>${esc(f.file)}</b> — ${esc(f.problem)}</li>`);
      for (const e of v?.errors || []) items.push(`<li><b>${esc(e.file)}${e.line ? ':' + e.line : ''}</b> — ${esc(e.text)}</li>`);
      for (const e of rec.steps?.export?.errors || []) items.push(`<li>${esc(e.text)}</li>`);
      if (rec.error) items.push(`<li>${esc(rec.error)}</li>`);
      overlay(`<div class="card"><h2>Build ${n} failed</h2><p>Still running build ${currentBuild ?? '—'}. Fix these and save — the server rebuilds automatically.</p><ul>${items.slice(0, 20).join('') || '<li>See console for details.</li>'}</ul><button onclick="this.closest('.overlay').hidden=true">Dismiss</button></div>`);
    } catch { /* ignore */ }
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.source !== iframe.contentWindow || !e.data?.__gck) return;
    const m = e.data;
    switch (m.kind) {
      case 'console':
        addLog(m.level, m.text);
        sendWs({ type: 'console', level: m.level, text: m.text });
        break;
      case 'status':
        if (m.state === 'started') setState('running', bridgeReady ? '' : 'waiting for bridge');
        else setState(m.state, m.error || '');
        if (m.state === 'crashed') addLog('error', `game crashed: ${m.error}`, 'shell');
        sendWs({ type: 'status', state: m.state === 'started' ? 'running' : m.state, build: m.build, error: m.error });
        break;
      case 'focus':
        iframe.focus();
        break;
      case 'game': {
        let msg;
        try { msg = JSON.parse(m.data); } catch { return; }
        if (msg.type === 'event' && msg.event === 'ready') {
          bridgeReady = true;
          setState('running');
          while (waiting.length) forwardToGame(waiting.shift());
        }
        if (msg.type === 'event' && msg.event === 'log' && msg.entry) addLog(msg.entry.level, `${msg.entry.file ? `${msg.entry.file}:${msg.entry.line} ` : ''}${msg.entry.text}`);
        if (msg.type === 'response') inflight.delete(msg.id);
        sendWs(msg);
        break;
      }
    }
  });

  function forwardToGame(msg) {
    inflight.set(msg.id, msg.cmd);
    iframe.contentWindow?.postMessage({ __gck: true, kind: 'command', data: JSON.stringify(msg) }, location.origin);
  }

  // ---------------------------------------------------------------- server connection
  function sendWs(msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); }

  async function api(url, opts = {}) {
    const r = await fetch(url, { credentials: 'same-origin', ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || r.statusText);
    return body;
  }

  function handleServer(msg) {
    switch (msg.type) {
      case 'command':
        if (msg.cmd === 'shell.reload') { loadBuild(currentBuild, `/builds/${project}/${currentBuild}/game.pck`); sendWs({ type: 'response', id: msg.id, ok: true, result: { reloaded: currentBuild } }); return; }
        if (msg.cmd === 'shell.info') { sendWs({ type: 'response', id: msg.id, ok: true, result: { build: currentBuild, state: gameState, bridgeReady, size: [iframe.clientWidth, iframe.clientHeight], ua: navigator.userAgent } }); return; }
        if (bridgeReady) forwardToGame(msg); else waiting.push(msg);
        return;
      case 'build_started':
        toast(`Building ${msg.n}…`, 60000);
        addLog('info', `build ${msg.n} started`, 'server');
        return;
      case 'build':
        if (msg.ok) {
          toast(`Build ${msg.n} ready`);
          addLog('info', `build ${msg.n} ready`, 'server');
          if (msg.reload && msg.pckUrl) loadBuild(msg.n, msg.pckUrl);
        } else {
          toast(`Build ${msg.n} failed`);
          addLog('error', `build ${msg.n} failed`, 'server');
          showBuildFailure(msg.n);
        }
        return;
    }
  }

  let retry = 500;
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/browser?project=${encodeURIComponent(project)}`);
    ws.onopen = () => {
      retry = 500;
      sendWs({ type: 'hello', info: { userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight] } });
      if (currentBuild != null) sendWs({ type: 'status', state: gameState === 'running' ? 'running' : gameState, build: currentBuild });
      addLog('info', 'connected to bridge server', 'shell');
    };
    ws.onmessage = (e) => { try { handleServer(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    ws.onclose = () => {
      addLog('warning', 'disconnected from server, retrying…', 'shell');
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 8000);
    };
  }

  async function start() {
    try {
      boot = await api(`/api/projects/${project}/boot`);
    } catch (e) {
      setState('crashed', e.message);
      overlay(`<div class="card"><h2>Can't open “${esc(project)}”</h2><p>${esc(e.message)}</p></div>`);
      return;
    }
    connect();
    if (boot.build) loadBuild(boot.build.n, boot.build.pckUrl);
    else { setState('idle', boot.building ? 'first build running' : 'no build yet'); overlay(`<div class="card"><h2>No playable build yet</h2><p>${boot.building ? 'The first build is running…' : 'Press Rebuild, or let the agent build.'}</p></div>`); }
  }

  // ---------------------------------------------------------------- buttons
  $('btn-reload').onclick = () => currentBuild != null && loadBuild(currentBuild, `/builds/${project}/${currentBuild}/game.pck`);
  $('btn-build').onclick = async () => {
    try { await api(`/api/projects/${project}/build`, { method: 'POST', body: JSON.stringify({ reason: 'browser' }) }); }
    catch (e) { toast(e.message); }
  };
  $('btn-tests').onclick = async () => {
    toast('Running tests…', 60000);
    try {
      const r = await api(`/api/projects/${project}/test`, { method: 'POST', body: JSON.stringify({ where: 'browser' }) });
      if (r.ok === false && r.error) throw new Error(r.error);
      toast(`Tests: ${r.passed}/${r.total} passed`);
      for (const t of r.results || []) addLog(t.passed ? 'info' : 'error', `${t.passed ? '✓' : '✗'} ${t.test}${t.message ? ' — ' + t.message : ''}`, 'test');
    } catch (e) { toast(e.message); }
  };
  $('btn-shot').onclick = async () => {
    try {
      const r = await api(`/api/projects/${project}/screenshot`, { method: 'POST', body: '{}' });
      if (!r.ok) throw new Error(r.error);
      window.open(r.url, '_blank');
    } catch (e) { toast(e.message); }
  };
  $('btn-clear').onclick = () => { logEl.innerHTML = ''; };
  $('only-errors').onchange = (e) => logEl.classList.toggle('errors-only', e.target.checked);

  start();
})();
