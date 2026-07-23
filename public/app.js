'use strict';
/* Worktree Studio frontend: SSE-driven state, session rail, live xterm dock,
   pluggable-source intake modal. Plain globals + xterm UMD (no bundler). */

const XTerm = window.Terminal;
const FitAddonCtor = (window.FitAddon && window.FitAddon.FitAddon) || null;
const WebLinksCtor = (window.WebLinksAddon && window.WebLinksAddon.WebLinksAddon) || null;

let state = { mux: '…', repos: [], sessions: [], servers: {}, sources: [], features: [], groups: [] };
let selectedId = null;
let renderedDockId = null;
let repoFilter = '';
let view = localStorage.getItem('wts-view') || 'work';

// intake modal state
const modal = { source: 'freetext', repo: '', issues: [], issueId: null };

// terminal state
let term = null, fit = null, ws = null, ro = null;

const $ = (sel) => document.querySelector(sel);
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch(url, opt);
  const txt = await res.text();
  let data; try { data = txt ? JSON.parse(txt) : {}; } catch { data = { raw: txt }; }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg, isErr) {
  const t = h(`<div class="toast ${isErr ? 'err' : ''}">${esc(msg)}</div>`);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), isErr ? 6000 : 3200);
}

/* ---------------- SSE ---------------- */
function connectSSE() {
  const ev = new EventSource('/api/events');
  ev.onmessage = (e) => { try { state = JSON.parse(e.data); render(); } catch { /* */ } };
  ev.onerror = () => { /* browser auto-reconnects */ };
}

/* ---------------- render ---------------- */
function stateDot(s) { return `<span class="dot ${s}"></span>`; }

function setView(v) {
  view = v;
  localStorage.setItem('wts-view', v);
  render();
}

function render() {
  $('#muxBadge').textContent = `mux: ${state.mux}`;
  document.querySelectorAll('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  const fleet = view === 'fleet';
  $('#workView').hidden = fleet;
  $('#fleetView').hidden = !fleet;
  if (fleet) { renderFleet(); return; }
  renderRepoFilter();
  renderRail();
  renderDock();
}

function renderRepoFilter() {
  const sel = $('#repoFilter');
  const cur = repoFilter;
  const names = [...new Set(state.sessions.map((s) => s.repoName))];
  sel.innerHTML = `<option value="">all repos</option>` + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  sel.value = cur;
}

function visibleSessions() {
  return state.sessions.filter((s) => !repoFilter || s.repoName === repoFilter);
}

function sessionCard(s) {
  const promoted = !!s.worktreePath;
  const card = h(`
    <div class="scard ${s.id === selectedId ? 'sel' : ''}" data-id="${s.id}">
      <div class="scard-top">
        ${stateDot(s.state)}
        <span class="scard-title">${esc(s.title)}</span>
        <span class="pill ${s.state}">${esc(s.state)}</span>
      </div>
      <div class="scard-meta">
        <span class="src">${esc(s.source)}</span>
        ${s.sourceUrl ? `<span class="link">${esc(labelForSource(s))}</span>` : ''}
        ${promoted ? `<span class="grp">${esc(s.repoName)}</span>` : `<span class="grp">main</span>`}
      </div>
      <div class="scard-act">${esc(s.activity || '')}</div>
    </div>`);
  card.addEventListener('click', () => selectSession(s.id));
  return card;
}

function groupHeader(label) {
  return h(`<div class="grouphd"><span>${esc(label)}</span><span class="gline"></span></div>`);
}

function renderRail() {
  const rail = $('#rail');
  const sessions = visibleSessions();
  rail.innerHTML = '';
  if (!sessions.length) {
    rail.appendChild(h(`<div class="scard-act" style="padding:14px;color:var(--faint)">No sessions yet. Click “+ New session”.</div>`));
  }
  // group promoted sessions by worktree name (their feature); unpromoted stand alone
  const byFeature = new Map();
  const loose = [];
  for (const s of sessions) {
    if (s.worktree) { if (!byFeature.has(s.worktree)) byFeature.set(s.worktree, []); byFeature.get(s.worktree).push(s); }
    else loose.push(s);
  }
  for (const [name, members] of byFeature) {
    rail.appendChild(groupHeader(members.length > 1 ? `⎇ ${name} · ${members.length} repos` : `⎇ ${name}`));
    members.forEach((s) => rail.appendChild(sessionCard(s)));
  }
  if (loose.length) {
    if (byFeature.size) rail.appendChild(groupHeader('In main · unpromoted'));
    loose.forEach((s) => rail.appendChild(sessionCard(s)));
  }
  const promotedCount = state.sessions.filter((s) => s.worktreePath).length;
  $('#railFoot').textContent = `${state.sessions.length} session(s) · ${promotedCount} worktree(s)`;
}

function labelForSource(s) {
  if (s.source === 'github') return `GH#${s.sourceId}`;
  if (s.source === 'gitlab') return `GL!${s.sourceId}`;
  if (s.source === 'asana') return 'Asana';
  return s.source;
}

function selectSession(id) { selectedId = id; render(); }

/* ---------------- dock ---------------- */
function renderDock() {
  const dock = $('#dock');
  const s = state.sessions.find((x) => x.id === selectedId);
  if (!s) { destroyTerminal(); renderedDockId = null; dock.innerHTML = ''; dock.appendChild(emptyState()); return; }
  if (renderedDockId !== s.id) { rebuildDock(s); renderedDockId = s.id; }
  else updateDock(s);
}

function emptyState() {
  const e = h(`<div class="empty">
    <div class="empty-glyph">⎇</div><h2>No session selected</h2>
    <p>Start one from any source — free text, a GitHub / GitLab issue, or an Asana task.</p>
    <button class="btn primary">+ New session</button></div>`);
  e.querySelector('button').addEventListener('click', openModal);
  return e;
}

function rebuildDock(s) {
  destroyTerminal();
  const dock = $('#dock');
  dock.innerHTML = '';
  dock.appendChild(h(`<div class="dock-head" id="dockHead"></div>`));
  dock.appendChild(h(`<div class="tabstrip" id="dockTabs"></div>`));
  dock.appendChild(h(`<div class="term-wrap" id="termWrap"></div>`));
  dock.appendChild(h(`<div class="serverbar" id="serverBar"></div>`));
  updateDock(s);
  openTerminal(s);
}

function updateDock(s) {
  const promoted = !!s.worktreePath;
  const head = $('#dockHead');
  const repoChips = (s.repos && s.repos.length ? s.repos : [{ repo: s.repoName, primary: true, worktreePath: s.worktreePath }])
    .map((r) => `<span class="repochip2${r.primary ? ' primary' : ''}" title="${r.worktreePath ? esc(r.worktreePath) : 'main (not promoted)'}">${r.primary ? '★ ' : ''}${esc(r.repo)}${r.worktreePath ? ' ⎇' : ''}</span>`).join('');
  head.innerHTML = `
    <span class="dot ${s.state}"></span>
    <span class="dock-title">${esc(s.title)}</span>
    ${s.sourceUrl ? `<a class="link" href="${esc(s.sourceUrl)}" target="_blank" rel="noreferrer">${esc(labelForSource(s))}</a>` : `<span class="src">${esc(s.source)}</span>`}
    <span class="repochips">${repoChips}</span>
    <span class="pill ${s.state}">${esc(s.state)}</span>
    <span class="dock-actions" id="dockActions"></span>`;
  const acts = head.querySelector('#dockActions');
  const addr = h(`<button class="btn sm" title="Add another repo to this feature">＋ repo</button>`);
  addr.addEventListener('click', () => addRepoToSession(s));
  acts.appendChild(addr);
  if (!promoted) {
    const b = h(`<button class="btn sm primary">⤴ Promote to worktree</button>`);
    b.addEventListener('click', () => promote(s));
    acts.appendChild(b);
  } else {
    const oc = h(`<button class="btn sm">Open in editor</button>`);
    oc.addEventListener('click', () => openEditor(s.worktreePath));
    acts.appendChild(oc);
  }
  const po = h(`<button class="btn sm">Pop out ⧉</button>`);
  po.addEventListener('click', () => popout(s));
  acts.appendChild(po);
  const ren = h(`<button class="btn sm ghost" title="Rename">✎</button>`);
  ren.addEventListener('click', () => renameSession(s));
  acts.appendChild(ren);
  if (s.active === false) {
    const act = h(`<button class="btn sm">Reactivate</button>`);
    act.addEventListener('click', () => activateSession(s));
    acts.appendChild(act);
  } else {
    const de = h(`<button class="btn sm ghost" title="Stop the process but keep the session (resumable)">Deactivate</button>`);
    de.addEventListener('click', () => deactivateSession(s));
    acts.appendChild(de);
  }
  const del = h(`<button class="btn sm ghost" title="Delete session (kills the multiplexer session)">🗑</button>`);
  del.addEventListener('click', () => closeSession(s));
  acts.appendChild(del);

  // tabs
  const tabs = $('#dockTabs');
  tabs.innerHTML = '';
  (s.tabs || [{ title: 'claude' }]).forEach((t, i) => {
    const tab = h(`<span class="tab ${i === 0 ? 'on' : ''}"><span class="dot ${i === 0 ? s.state : 'idle'}"></span>${esc(t.title)}</span>`);
    tab.addEventListener('click', () => selectTab(s, i, tabs));
    tabs.appendChild(tab);
  });
  const add = h(`<span class="tab"><span class="newtab">＋</span></span>`);
  add.addEventListener('click', () => addTab(s));
  tabs.appendChild(add);
  const pop = h(`<button class="btn xs popout">Pop out ⧉</button>`);
  pop.addEventListener('click', () => popout(s));
  tabs.appendChild(pop);

  // server bar
  const bar = $('#serverBar');
  const st = state.servers[s.id];
  if (!promoted) {
    bar.innerHTML = `<span>Promote to a worktree to run dev servers.</span>`;
  } else if (!st || !st.configured) {
    bar.innerHTML = `<span>No dev-server config for <b>${esc(s.repoName)}</b> (set <code>start.${esc(s.repoName)}</code> in config).</span>`;
  } else {
    const chips = (st.ports || []).map((p) => `<span class="portchip"><span class="dot ${p.up ? 'done' : 'idle'}"></span>:${p.port}</span>`).join('');
    bar.innerHTML = `<span>servers ${chips || '—'}</span><span class="spacer" style="flex:1"></span>`;
    const btn = h(`<button class="btn sm">${st.running ? 'Stop' : 'Run server'}</button>`);
    btn.addEventListener('click', () => (st.running ? stopServer(s) : startServer(s)));
    bar.appendChild(btn);
  }
}

/* ---------------- terminal ---------------- */
function themeForTerm() {
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  return light
    ? { background: '#12151b', foreground: '#cdd4de', cursor: '#d05f30' }
    : { background: '#0c0f14', foreground: '#cdd4de', cursor: '#e0733f' };
}

function destroyTerminal() {
  try { if (ro) ro.disconnect(); } catch { /* */ }
  try { if (ws) { ws.onclose = null; ws.close(); } } catch { /* */ }
  try { if (term) term.dispose(); } catch { /* */ }
  ro = ws = term = fit = null;
}

function openTerminal(s) {
  const wrap = $('#termWrap');
  if (!wrap || !XTerm) return;
  term = new XTerm({ fontFamily: 'ui-monospace, SF Mono, Menlo, monospace', fontSize: 12.5, cursorBlink: true, scrollback: 8000, allowProposedApi: true, theme: themeForTerm() });
  if (FitAddonCtor) { fit = new FitAddonCtor(); term.loadAddon(fit); }
  if (WebLinksCtor) { try { term.loadAddon(new WebLinksCtor()); } catch { /* */ } }
  term.open(wrap);
  try { fit && fit.fit(); } catch { /* */ }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/term?session=${encodeURIComponent(s.id)}&cols=${term.cols}&rows=${term.rows}`);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (e) => { if (typeof e.data === 'string') term.write(e.data); else term.write(new Uint8Array(e.data)); };
  ws.onopen = () => { sendResize(); term.focus(); };
  ws.onclose = () => { try { term.write('\r\n\x1b[2m[disconnected — reselect to reattach]\x1b[0m\r\n'); } catch { /* */ } };
  term.onData((d) => { if (ws && ws.readyState === 1) ws.send(new TextEncoder().encode(d)); });
  ro = new ResizeObserver(() => { try { fit && fit.fit(); sendResize(); } catch { /* */ } });
  ro.observe(wrap);
}

function sendResize() {
  if (ws && ws.readyState === 1 && term) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
}

/* ---------------- actions ---------------- */
async function promote(s) {
  const branch = prompt('Branch to create for this worktree:', s.suggestedBranch || 'feature/x');
  if (!branch) return;
  try { await api('POST', `/api/sessions/${s.id}/promote`, { branch }); toast(`Promoted → worktree on ${branch}`); }
  catch (e) { toast(e.message, true); }
}
async function popout(s) {
  try { await api('POST', `/api/sessions/${s.id}/popout`, {}); toast('Popped out to a native terminal (same live session).'); }
  catch (e) { toast(e.message, true); }
}
async function addRepoToSession(s) {
  const have = new Set((s.repos || []).map((r) => r.repo));
  const avail = state.repos.map((r) => r.name).filter((n) => !have.has(n));
  if (!avail.length) return toast('No other repos to add.', true);
  const pick = prompt(`Add which repo to this feature? Creates a same-named worktree there and gives the session access.\n\nAvailable: ${avail.join(', ')}`, avail[0]);
  if (!pick || !avail.includes(pick)) return;
  try { const r = await api('POST', `/api/sessions/${s.id}/add-repo`, { repo: pick }); toast(r.already ? `${pick} already in feature` : `Added ${pick} → ${r.worktree.name}`); }
  catch (e) { toast(e.message, true); }
}
async function addTab(s) {
  const title = prompt('New tab name:', 'shell'); if (title === null) return;
  try { await api('POST', `/api/sessions/${s.id}/tabs`, { title: title || 'shell' }); toast(`Tab “${title || 'shell'}” added`); }
  catch (e) { toast(e.message, true); }
}
async function selectTab(s, i, tabsEl) {
  tabsEl.querySelectorAll('.tab').forEach((t, idx) => t.classList.toggle('on', idx === i));
  try { await api('POST', `/api/sessions/${s.id}/select-tab`, { index: i }); if (term) term.focus(); } catch (e) { toast(e.message, true); }
}
async function closeSession(s) {
  if (!confirm(`Delete “${s.title}”? This kills its ${state.mux} session and removes it.`)) return;
  try { await api('DELETE', `/api/sessions/${s.id}`); if (selectedId === s.id) selectedId = null; toast('Session deleted'); }
  catch (e) { toast(e.message, true); }
}
async function renameSession(s) {
  const title = prompt('Rename session:', s.title); if (title === null || !title.trim()) return;
  try { await api('POST', `/api/sessions/${s.id}/rename`, { title }); toast('Renamed'); } catch (e) { toast(e.message, true); }
}
async function deactivateSession(s) {
  if (!confirm(`Deactivate “${s.title}”? Stops the process; you can reactivate to resume the conversation.`)) return;
  try { await api('POST', `/api/sessions/${s.id}/deactivate`, {}); toast('Deactivated'); } catch (e) { toast(e.message, true); }
}
async function activateSession(s) {
  try { await api('POST', `/api/sessions/${s.id}/activate`, {}); toast('Reactivated — resuming'); } catch (e) { toast(e.message, true); }
}
async function startServer(s) { try { const r = await api('POST', '/api/servers/start', { repo: s.repoName, worktreePath: s.worktreePath }); toast(r.ok ? `Server starting (pid ${r.pid})` : r.error, !r.ok); } catch (e) { toast(e.message, true); } }
async function stopServer(s) { try { await api('POST', '/api/servers/stop', { repo: s.repoName, worktreePath: s.worktreePath }); toast('Server stopped'); } catch (e) { toast(e.message, true); } }
async function openEditor(p) { try { await api('POST', '/api/open', { path: p }); } catch (e) { toast(e.message, true); } }

/* ---------------- intake modal ---------------- */
function openModal() {
  modal.repo = modal.repo || (state.repos[0] && state.repos[0].name) || '';
  modal.source = 'freetext'; modal.issues = []; modal.issueId = null;
  // reset the form fields each open
  if ($('#mText')) $('#mText').value = '';
  if ($('#mName')) $('#mName').value = '';
  renderModal();
  $('#modal').hidden = false;
  setTimeout(() => $('#mText') && $('#mText').focus(), 30);
}
function closeModal() { $('#modal').hidden = true; }

function renderModal() {
  // source tabs
  const tabs = $('#srctabs');
  const known = [{ id: 'freetext', label: 'Free text' }, { id: 'github', label: 'GitHub' }, { id: 'gitlab', label: 'GitLab' }, { id: 'asana', label: 'Asana' }];
  const enabled = new Set(state.sources.map((s) => s.id));
  tabs.innerHTML = '';
  for (const t of known) {
    const on = modal.source === t.id;
    const dis = !enabled.has(t.id);
    const el = h(`<span class="srctab ${on ? 'on' : ''}" ${dis ? 'disabled' : ''}>${esc(t.label)}</span>`);
    if (!dis) el.addEventListener('click', () => { modal.source = t.id; modal.issues = []; modal.issueId = null; renderModal(); });
    tabs.appendChild(el);
  }
  // repos
  const rsel = $('#mRepo');
  rsel.innerHTML = state.repos.map((r) => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');
  rsel.value = modal.repo;
  rsel.onchange = () => { modal.repo = rsel.value; modal.issues = []; renderModal(); };

  const isFree = modal.source === 'freetext';
  const isAsana = modal.source === 'asana';
  $('#fFreetext').hidden = !isFree;
  $('#fIssue').hidden = isFree;
  // issue list
  const list = $('#mIssues');
  list.innerHTML = modal.issues.length
    ? '' : `<div class="modal-note">Click “Load” to fetch ${isAsana ? 'your Asana tasks' : 'open issues'}.</div>`;
  for (const it of modal.issues) {
    const el = h(`<div class="issue ${modal.issueId === it.id ? 'sel' : ''}"><span class="num">${esc(it.subtitle || it.id)}</span> <span>${esc(it.title)}</span></div>`);
    el.addEventListener('click', () => { modal.issueId = it.id; renderModal(); });
    list.appendChild(el);
  }
  $('#mLoad').onclick = loadIssues;

  // additional repos this feature may touch (everything except the primary)
  const extra = $('#mExtraRepos');
  extra.innerHTML = state.repos.filter((r) => r.name !== modal.repo)
    .map((r) => `<label class="repocheck"><input type="checkbox" value="${esc(r.name)}"/> ${esc(r.name)}</label>`).join('') || '<span class="hint">no other repos</span>';

  $('#mNote').textContent = isFree
    ? 'Boots a real Claude Code session in the repo (CLAUDE.md loaded). The name is optional; the branch is chosen when you promote.'
    : `Seeds the session from ${modal.source}. ${state.sources.find((s) => s.id === modal.source && s.needsRepo) ? 'Uses the selected repo.' : ''}`;
  $('#mFootNote').textContent = `→ ${state.mux} session · seeds first message`;
}

async function loadIssues() {
  $('#mLoad').textContent = 'Loading…';
  try {
    const out = await api('GET', `/api/sources/${modal.source}/items?repo=${encodeURIComponent(modal.repo)}`);
    if (!out.ok) throw new Error(out.error || 'failed');
    modal.issues = out.items || [];
    if (!modal.issues.length) toast('No items found.');
  } catch (e) { toast(e.message, true); }
  $('#mLoad').textContent = 'Load';
  renderModal();
}

async function startSession() {
  const body = { source: modal.source, repo: modal.repo };
  if (modal.source === 'freetext') {
    body.text = $('#mText').value;
    if (!body.text.trim()) return toast('Describe what you’re working on first.', true);
    if ($('#mName').value.trim()) body.name = $('#mName').value.trim();
  } else { if (!modal.issueId) return toast('Pick an item first.', true); body.sourceId = modal.issueId; }
  const extra = [...document.querySelectorAll('#mExtraRepos input:checked')].map((c) => c.value);
  if (extra.length) body.additionalRepos = extra;
  try {
    const s = await api('POST', '/api/sessions', body);
    closeModal();
    selectedId = s.id;
    setView('work');
    toast(`Session started — ${s.title}`);
  } catch (e) { toast(e.message, true); }
}

/* ---------------- fleet view ---------------- */
function featureState(f) {
  const ms = f.members.filter((m) => m && !m.missing);
  if (ms.some((m) => m.session && m.session.state === 'waiting')) return 'waiting';
  if (ms.some((m) => m.session && m.session.state === 'working')) return 'working';
  if (ms.some((m) => m.running)) return 'done';
  return 'idle';
}

function renderFleet() {
  const feats = state.features || [];
  const flat = feats.flatMap((f) => f.members.filter((m) => m && !m.missing));
  const running = flat.filter((m) => m.running).length;
  const waiting = flat.filter((m) => m.session && m.session.state === 'waiting').length;
  const workingA = flat.filter((m) => m.session && m.session.state === 'working').length;

  const sum = $('#fleetSummary');
  sum.innerHTML = `
    <span><b>${feats.length}</b> features</span>
    <span class="chip"><span class="dot done"></span><b>${running}</b> running</span>
    <span class="chip"><span class="dot working"></span>${workingA} working</span>
    <span class="chip"><span class="dot waiting"></span>${waiting} waiting</span>
    <span class="grow"></span>`;
  const stopAll = h(`<button class="btn sm">Stop all</button>`); stopAll.addEventListener('click', () => feats.forEach((f) => f.members.some((m) => m.running) && stopStack(f.name)));
  const restartAll = h(`<button class="btn sm">Restart all</button>`); restartAll.addEventListener('click', () => feats.forEach((f) => f.members.some((m) => m.running) && restartStack(f.name)));
  sum.appendChild(restartAll); sum.appendChild(stopAll);

  const tbl = $('#fleetTable');
  tbl.innerHTML = `<thead><tr>
    <th>Feature</th><th>Stack · branches</th><th>Servers</th><th>Agents</th><th>State</th><th>Actions</th>
  </tr></thead>`;
  const tbody = document.createElement('tbody');
  if (!feats.length) tbody.appendChild(h(`<tr><td colspan="6" style="color:var(--faint);padding:22px 16px">No worktrees found under your base dirs. Create one from a session (promote) or with git worktree.</td></tr>`));
  for (const f of feats) {
    const ms = f.members.filter((m) => m && !m.missing);
    const anyRunning = ms.some((m) => m.running);
    const anyStartable = ms.some((m) => m.canStart && !m.running);
    const anyMerged = ms.some((m) => m.merged);
    const fs = featureState(f);

    const tr = document.createElement('tr');
    tr.appendChild(h(`<td><span class="feat">${stateDot(fs)}${esc(f.name)}${f.auto ? '' : ' <span class="src">manual</span>'}</span></td>`));
    tr.appendChild(h(`<td><div class="repos">${ms.map((m) => `<span><span class="r">${esc(m.repo)}</span> <span class="br">${esc(m.branch || m.wtname)}</span>${m.merged ? ' <span class="badge merged">✓ merged</span>' : ''}</span>`).join('')}</div></td>`));
    tr.appendChild(h(`<td><div class="ports">${ms.map((m) => `<span class="p"><span class="dot ${m.running ? 'done' : 'idle'}"></span>${(m.ports || []).map((p) => ':' + p).join(' ') || (m.canStart ? 'stopped' : '—')}</span>`).join('')}</div></td>`));
    tr.appendChild(h(`<td><div class="agents">${ms.map((m) => m.session ? `<span><span class="dot ${m.session.state}"></span>${esc(m.session.state)}</span>` : '<span style="color:var(--faint)">—</span>').join('')}</div></td>`));
    tr.appendChild(h(`<td><span class="badge ${anyRunning ? 'run' : 'stop'}">${anyRunning ? '● running' : '○ stopped'}</span></td>`));

    const acts = h(`<td><div class="rowacts"></div></td>`);
    const box = acts.querySelector('.rowacts');
    if (anyStartable) { const b = h(`<button class="btn sm ${anyRunning ? '' : 'primary'}">${anyRunning ? 'Restart stack' : 'Run stack'}</button>`); b.addEventListener('click', () => (anyRunning ? restartStack(f.name) : runStack(f.name))); box.appendChild(b); }
    if (anyRunning) { const b = h(`<button class="btn sm">Stop</button>`); b.addEventListener('click', () => stopStack(f.name)); box.appendChild(b); }
    const openb = h(`<button class="btn sm ghost">Open</button>`); openb.addEventListener('click', () => openGroup(f.name)); box.appendChild(openb);
    // per-member session/cleanup
    for (const m of ms) {
      if (!m.session) { const b = h(`<button class="btn sm">Session ▸ ${esc(m.repo)}</button>`); b.addEventListener('click', () => adoptWorktree(m)); box.appendChild(b); }
      if (m.merged) { const b = h(`<button class="btn sm ghost">Remove ${esc(m.repo)}</button>`); b.addEventListener('click', () => removeWorktree(m)); box.appendChild(b); }
    }
    tr.appendChild(acts);
    tbody.appendChild(tr);
  }
  tbl.appendChild(tbody);
}

async function runStack(name) {
  try {
    const r = await api('POST', '/api/group/start', { group: name });
    if (r.needsConfirm) {
      const list = r.conflicts.map((c) => `${c.repo} (${c.ports.join(',') || 'running'})`).join(', ');
      if (!confirm(`Stop & switch? These are using needed ports: ${list}`)) return;
      const r2 = await api('POST', '/api/group/start', { group: name, stopConflicts: true });
      toast(`Switched — started ${r2.started}/${r2.total}`);
    } else {
      toast(`Started ${r.started}/${r.total}` + (r.failures && r.failures.length ? ` (${r.failures.length} failed)` : ''), r.failures && r.failures.length);
    }
  } catch (e) { toast(e.message, true); }
}
async function stopStack(name) { try { await api('POST', '/api/group/stop', { group: name }); toast(`Stopped ${name}`); } catch (e) { toast(e.message, true); } }
async function restartStack(name) { try { await api('POST', '/api/group/restart', { group: name }); toast(`Restarting ${name}`); } catch (e) { toast(e.message, true); } }
async function openGroup(name) { try { await api('POST', '/api/group/open', { group: name }); } catch (e) { toast(e.message, true); } }
async function removeWorktree(m) {
  if (!confirm(`Remove worktree ${m.repo}/${m.wtname}?` + (m.merged ? ' (branch is merged)' : ''))) return;
  const delBranch = m.merged && confirm(`Also delete the merged branch ${m.branch}?`);
  try { const r = await api('DELETE', '/api/worktrees', { repo: m.repo, worktreePath: m.path, branch: m.branch, deleteBranch: delBranch }); toast(r.ok ? 'Worktree removed' : r.error, !r.ok); } catch (e) { toast(e.message, true); }
}
async function adoptWorktree(m) {
  try { const s = await api('POST', '/api/worktrees/adopt', { repo: m.repo, worktreePath: m.path, branch: m.branch, wtname: m.wtname }); selectedId = s.id; setView('work'); toast(`Session started in ${m.repo}/${m.wtname}`); } catch (e) { toast(e.message, true); }
}

/* ---------------- settings / connections ---------------- */
async function openSettings() {
  let data;
  try { data = await api('GET', '/api/settings'); } catch (e) { return toast(e.message, true); }
  const src = data.sources || {};
  const gl = src.gitlab || {}; const as = src.asana || {};
  const body = $('#settingsBody');
  body.innerHTML = `
    <div class="field">
      <label>GitHub <span class="hint">— uses the <code>gh</code> CLI</span></label>
      <div class="conn-status">${data.tools.gh ? (data.githubAuthed ? '<span class="ok">✓ gh installed &amp; authenticated</span>' : '<span class="warn">gh installed — run <code>gh auth login</code></span>') : '<span class="warn">gh not installed (brew install gh)</span>'}</div>
    </div>
    <div class="field">
      <label><input type="checkbox" id="setGlEnabled" ${gl.enabled ? 'checked' : ''}/> GitLab <span class="hint">${data.tools.glab ? '— glab CLI available' : '— uses API token'}</span></label>
      <input id="setGlHost" class="input" placeholder="https://gitlab.com" value="${esc(gl.host || 'https://gitlab.com')}"/>
      <input id="setGlProject" class="input" placeholder="group/project (for API mode)" value="${esc(gl.project || '')}"/>
      <input id="setGlToken" class="input" type="password" placeholder="Personal access token" value="${esc(gl.token || '')}"/>
    </div>
    <div class="field">
      <label><input type="checkbox" id="setAsEnabled" ${as.enabled ? 'checked' : ''}/> Asana <span class="hint">— API token</span></label>
      <input id="setAsToken" class="input" type="password" placeholder="Personal access token" value="${esc(as.token || '')}"/>
      <input id="setAsWorkspace" class="input" placeholder="Workspace GID" value="${esc(as.workspace || '')}"/>
    </div>`;
  $('#settingsModal').hidden = false;
}
function closeSettings() { $('#settingsModal').hidden = true; }
async function saveSettings() {
  const sources = {
    gitlab: { enabled: $('#setGlEnabled').checked, host: $('#setGlHost').value.trim(), project: $('#setGlProject').value.trim(), token: $('#setGlToken').value.trim() },
    asana: { enabled: $('#setAsEnabled').checked, token: $('#setAsToken').value.trim(), workspace: $('#setAsWorkspace').value.trim() },
  };
  try { await api('POST', '/api/settings', { sources }); closeSettings(); toast('Connections saved'); } catch (e) { toast(e.message, true); }
}

/* ---------------- theme + wiring ---------------- */
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme')
    || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('wts-theme', next);
  if (term) term.options.theme = themeForTerm();
}

function init() {
  const saved = localStorage.getItem('wts-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  $('#newBtn').addEventListener('click', openModal);
  $('#emptyNew') && $('#emptyNew').addEventListener('click', openModal);
  $('#themeBtn').addEventListener('click', toggleTheme);
  $('#modalClose').addEventListener('click', closeModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#mStart').addEventListener('click', startSession);
  $('#repoFilter').addEventListener('change', (e) => { repoFilter = e.target.value; render(); });
  document.querySelectorAll('#viewSeg button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settingsClose').addEventListener('click', closeSettings);
  $('#setCancel').addEventListener('click', closeSettings);
  $('#setSave').addEventListener('click', saveSettings);
  $('#settingsModal').addEventListener('click', (e) => { if (e.target.id === 'settingsModal') closeSettings(); });
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  connectSSE();
}
document.addEventListener('DOMContentLoaded', init);
