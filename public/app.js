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
const fleetPending = new Set(); // feature-name / 'adopt:<path>' keys with an action in flight

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

/* ---------------- custom dialogs (no native alert/confirm/prompt) ---------------- */
function uiDialog({ title, message, messageHtml, fields = [], okLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const back = h('<div class="modal-backdrop"></div>');
    const modal = h('<div class="modal dlg"></div>');
    modal.innerHTML = `
      <div class="modal-head"><b>${esc(title || '')}</b><span class="spacer"></span></div>
      <div class="modal-body">
        ${messageHtml ? `<div class="dlg-msg">${messageHtml}</div>` : (message ? `<div class="dlg-msg">${esc(message)}</div>` : '')}
        ${fields.map((f, i) => {
    if (f.type === 'checkbox') return `<label class="dlg-check"><input type="checkbox" class="dlgf" data-i="${i}" data-t="checkbox" ${f.value ? 'checked' : ''}/> ${esc(f.label || '')}</label>`;
    if (f.type === 'select') return `<div class="field"><label>${esc(f.label || '')}</label><select class="select dlgf" data-i="${i}" data-t="select">${(f.options || []).map((o) => `<option value="${esc(o)}" ${o === f.value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div>`;
    return `<div class="field"><label>${esc(f.label || '')}</label><input class="input dlgf" data-i="${i}" data-t="text" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}"/></div>`;
  }).join('')}
      </div>
      <div class="modal-foot"><span class="spacer"></span>
        ${cancelLabel ? `<button class="btn dlg-cancel">${esc(cancelLabel)}</button>` : ''}
        <button class="btn ${danger ? 'danger' : 'primary'} dlg-ok">${esc(okLabel)}</button>
      </div>`;
    back.appendChild(modal);
    document.body.appendChild(back);
    const readFields = () => [...modal.querySelectorAll('.dlgf')].map((el) => (el.dataset.t === 'checkbox' ? el.checked : el.value));
    let onKey;
    const done = (val) => { document.removeEventListener('keydown', onKey); back.remove(); resolve(val); };
    onKey = (e) => { if (e.key === 'Escape') done(null); else if (e.key === 'Enter' && !fields.some((f) => f.type === 'select')) { e.preventDefault(); done(fields.length ? readFields() : true); } };
    document.addEventListener('keydown', onKey);
    const cancelBtn = modal.querySelector('.dlg-cancel'); if (cancelBtn) cancelBtn.onclick = () => done(null);
    modal.querySelector('.dlg-ok').onclick = () => done(fields.length ? readFields() : true);
    back.addEventListener('click', (e) => { if (e.target === back) done(null); });
    const first = modal.querySelector('.dlgf'); if (first && first.focus) setTimeout(() => { first.focus(); if (first.select) first.select(); }, 30);
  });
}
async function uiConfirm(message, opts = {}) { return (await uiDialog({ title: opts.title || 'Confirm', message, okLabel: opts.okLabel || 'OK', danger: opts.danger })) === true; }
async function uiPrompt(message, value = '', opts = {}) {
  const r = await uiDialog({ title: message, fields: [{ type: 'text', label: opts.label || '', value, placeholder: opts.placeholder || '' }], okLabel: opts.okLabel || 'OK' });
  return r ? r[0] : null;
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
        ${promoted ? (s.repos && s.repos.length ? s.repos.map((r) => `<span class="grp">${esc(r.repo)}</span>`).join('') : `<span class="grp">${esc(s.repoName)}</span>`) : `<span class="grp">main</span>`}
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
  const tabList = s.tabs || [{ title: 'claude' }];
  tabList.forEach((t, i) => {
    const closable = tabList.length > 1; // any tab can be closed when more than one
    const tab = h(`<span class="tab ${i === 0 ? 'on' : ''}"><span class="dot ${i === 0 ? s.state : 'idle'}"></span>${esc(t.title)}${closable ? ' <span class="tabclose" title="Close tab">✕</span>' : ''}</span>`);
    tab.addEventListener('click', () => selectTab(s, i, tabs));
    const x = tab.querySelector('.tabclose');
    if (x) x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(s, i); });
    tabs.appendChild(tab);
  });
  const add = h(`<span class="tab"><span class="newtab">＋</span></span>`);
  add.addEventListener('click', () => addTab(s));
  tabs.appendChild(add);
  const pop = h(`<button class="btn xs popout">Pop out ⧉</button>`);
  pop.addEventListener('click', () => popout(s));
  tabs.appendChild(pop);

  // server bar — the whole shared workspace (every repo this session owns)
  const bar = $('#serverBar');
  const st = state.servers[s.id];
  const reps = (st && st.repos) || [];
  if (!promoted) {
    bar.innerHTML = '<span>Promote to a worktree to run dev servers.</span>';
  } else if (!reps.some((r) => r.canStart)) {
    bar.innerHTML = `<span>No dev-server config for this feature’s repos (set <code>start.&lt;repo&gt;</code> in config).</span>`;
  } else {
    const anyRunning = reps.some((r) => r.running);
    const anyStopped = reps.some((r) => r.canStart && !r.running);
    bar.innerHTML = '<span>workspace</span>'
      + reps.map((r) => `<span class="portchip"><span class="dot ${r.running ? 'done' : 'idle'}"></span>${esc(r.repo)}${r.ports.length ? ' ' + r.ports.map((p) => ':' + p).join(' ') : ''}</span>`).join('')
      + '<span class="spacer" style="flex:1"></span>';
    if (anyStopped) { const b = h(`<button class="btn sm go">${anyRunning ? 'Run rest' : 'Run all'}</button>`); b.addEventListener('click', () => startSessionServers(s)); bar.appendChild(b); }
    if (anyRunning) { const b = h('<button class="btn sm danger">Stop all</button>'); b.addEventListener('click', () => stopSessionServers(s)); bar.appendChild(b); }
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
  const branch = await uiPrompt('Branch to create for this worktree:', s.suggestedBranch || 'feature/x');
  if (!branch) return;
  try {
    const r = await api('POST', `/api/sessions/${s.id}/promote`, { branch });
    const w = r.worktree || {};
    const warn = (w.warnings || []).find((x) => /taken/.test(x));
    toast(warn ? `Promoted as “${w.name}” — ${warn}` : `Promoted → ${w.branch || branch}`);
  } catch (e) { toast(e.message, true); }
}
async function popout(s) {
  try { await api('POST', `/api/sessions/${s.id}/popout`, {}); toast('Popped out to a native terminal (same live session).'); }
  catch (e) { toast(e.message, true); }
}
async function addRepoToSession(s) {
  const have = new Set((s.repos || []).map((r) => r.repo));
  const avail = state.repos.map((r) => r.name).filter((n) => !have.has(n));
  if (!avail.length) return toast('No other repos to add.', true);
  const r0 = await uiDialog({ title: 'Add a repo to this feature', message: 'Creates a same-named worktree there and gives the session access.', fields: [{ type: 'select', label: 'Repo', value: avail[0], options: avail }], okLabel: 'Add' });
  if (!r0) return;
  const pick = r0[0];
  if (!avail.includes(pick)) return;
  try { const r = await api('POST', `/api/sessions/${s.id}/add-repo`, { repo: pick }); toast(r.already ? `${pick} already in feature` : `Added ${pick} → ${r.worktree.name}`); }
  catch (e) { toast(e.message, true); }
}
async function addTab(s) {
  const title = await uiPrompt('New tab name:', 'shell'); if (title === null) return;
  try { await api('POST', `/api/sessions/${s.id}/tabs`, { title: title || 'shell' }); toast(`Tab “${title || 'shell'}” added`); }
  catch (e) { toast(e.message, true); }
}
async function selectTab(s, i, tabsEl) {
  tabsEl.querySelectorAll('.tab').forEach((t, idx) => t.classList.toggle('on', idx === i));
  try { await api('POST', `/api/sessions/${s.id}/select-tab`, { index: i }); if (term) term.focus(); } catch (e) { toast(e.message, true); }
}
async function closeTab(s, i) {
  try { await api('POST', `/api/sessions/${s.id}/close-tab`, { index: i }); toast('Tab closed'); } catch (e) { toast(e.message, true); }
}
async function closeSession(s) {
  if (!(await uiConfirm(`Delete “${s.title}”? This kills its ${state.mux} session and removes it.`, { title: 'Delete session', okLabel: 'Delete', danger: true }))) return;
  try { await api('DELETE', `/api/sessions/${s.id}`); if (selectedId === s.id) selectedId = null; toast('Session deleted'); }
  catch (e) { toast(e.message, true); }
}
async function renameSession(s) {
  const title = await uiPrompt('Rename session:', s.title); if (title === null || !title.trim()) return;
  try { await api('POST', `/api/sessions/${s.id}/rename`, { title }); toast('Renamed'); } catch (e) { toast(e.message, true); }
}
async function deactivateSession(s) {
  if (!(await uiConfirm(`Deactivate “${s.title}”? Stops the process; you can reactivate to resume the conversation.`, { title: 'Deactivate', okLabel: 'Deactivate' }))) return;
  try { await api('POST', `/api/sessions/${s.id}/deactivate`, {}); toast('Deactivated'); } catch (e) { toast(e.message, true); }
}
async function activateSession(s) {
  try { await api('POST', `/api/sessions/${s.id}/activate`, {}); toast('Reactivated — resuming'); } catch (e) { toast(e.message, true); }
}
// start/stop every dev server in the session's shared workspace
async function startSessionServers(s) { try { const r = await api('POST', `/api/sessions/${s.id}/servers/start`, {}); toast(r.ok ? 'Workspace servers starting' : 'Some failed to start', !r.ok); } catch (e) { toast(e.message, true); } }
async function stopSessionServers(s) { try { await api('POST', `/api/sessions/${s.id}/servers/stop`, {}); toast('Workspace servers stopped'); } catch (e) { toast(e.message, true); } }
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
  // stable alphabetical order so a feature doesn't jump around when it starts
  const feats = (state.features || []).slice().sort((a, b) => a.name.localeCompare(b.name));
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

  const list = $('#fleetTable');
  list.innerHTML = '';
  if (!feats.length) { list.appendChild(h(`<div class="fleet-empty">No worktrees found under your base dirs. Create one from a session (promote) or with git worktree.</div>`)); return; }

  const isActive = (f) => f.members.some((m) => m && !m.missing && (m.running || (m.session && m.session.state !== 'stopped')));
  const activeFeats = feats.filter(isActive);
  const idleFeats = feats.filter((f) => !isActive(f));
  const section = (label, n) => h(`<div class="sectionrow">${esc(label)} · ${n}</div>`);
  if (activeFeats.length) { list.appendChild(section('▶ Running', activeFeats.length)); activeFeats.forEach((f) => list.appendChild(featureRow(f))); }
  if (idleFeats.length) { if (activeFeats.length) list.appendChild(section('Idle', idleFeats.length)); idleFeats.forEach((f) => list.appendChild(featureRow(f))); }
}

// Option B: a two-line row (decision line + stack line) with an ⋯ overflow menu.
function featureRow(f) {
  const ms = f.members.filter((m) => m && !m.missing);
  const anyRunning = ms.some((m) => m.running);
  const anyStartable = ms.some((m) => m.canStart && !m.running);
  const fs = featureState(f);
  const pend = fleetPending.has(f.name);
  const sess = f.session; // one session per feature
  const btn = (label, fn, cls = '') => { const b = h(`<button class="btn sm ${cls}">${label}</button>`); b.addEventListener('click', fn); return b; };

  const row = h('<div class="frow"></div>');
  // line 1 — the decision line
  const l1 = h('<div class="frow-l1"></div>');
  l1.appendChild(h(`<span class="fname">${esc(f.name)}${f.auto ? '' : ' <span class="src">manual</span>'}</span>`));
  // two clearly-labelled statuses: the agent (Claude session) and the dev servers
  if (sess) l1.appendChild(h(`<span class="pill agent ${sess.state}" title="Agent — the Claude session"><span class="dot ${sess.state}"></span>agent · ${esc(sess.state)}</span>`));
  l1.appendChild(h(`<span class="pill srv ${anyRunning ? 'done' : 'idle'}" title="Dev servers"><span class="pi">⇅</span>servers · ${anyRunning ? 'running' : 'stopped'}</span>`));
  l1.appendChild(h('<span class="grow"></span>'));
  if (pend) {
    l1.appendChild(h('<button class="btn sm" disabled>working…</button>'));
  } else {
    l1.appendChild(sess ? btn('Go to session ▸', () => goToSession(sess.id), 'primary') : btn('Start session', () => startFeatureSession(f), 'primary'));
    if (anyRunning) l1.appendChild(btn('Stop stack', () => stopStack(f.name), 'danger'));
    else if (anyStartable) l1.appendChild(btn('Run stack', () => runStack(f.name), 'go'));
    const more = h('<button class="btn sm ghost fmore" title="More">⋯</button>');
    more.addEventListener('click', (e) => { e.stopPropagation(); openFeatureMenu(more, f, { anyRunning, sess }); });
    l1.appendChild(more);
  }
  row.appendChild(l1);

  // line 2 — the stack detail
  const l2 = h('<div class="frow-l2"></div>');
  l2.innerHTML = ms.map((m) => `<span class="mchip"><span class="dot ${m.session ? m.session.state : (m.running ? 'done' : 'idle')}"></span><span class="r">${esc(m.repo)}</span> <span class="br">${esc(m.branch || m.wtname)}</span>${(m.ports || []).length ? ` <span class="p">${m.ports.map((p) => ':' + p).join(' ')}</span>` : ''}${m.merged ? ' <span class="badge merged">✓ merged</span>' : ''}</span>`).join('');
  row.appendChild(l2);
  return row;
}

function closeAnyMenu() { document.querySelectorAll('.fmenu').forEach((m) => m.remove()); }
function openFeatureMenu(anchor, f, { anyRunning, sess }) {
  const existing = document.querySelector('.fmenu');
  const wasThis = existing && existing._anchor === anchor;
  closeAnyMenu();
  if (wasThis) return; // clicking the same ⋯ again toggles it closed
  const menu = h('<div class="fmenu"></div>');
  menu._anchor = anchor;
  const item = (label, fn, cls = '') => { const d = h(`<div class="${cls}">${esc(label)}</div>`); d.addEventListener('click', () => { closeAnyMenu(); fn(); }); menu.appendChild(d); };
  item('Open in editor', () => openGroup(f.name));
  if (anyRunning) item('Restart stack', () => restartStack(f.name));
  item('Open PR / MR', () => prFeature(f.name));
  menu.appendChild(h('<div class="sep"></div>'));
  if (anyRunning || sess) item('Close feature', () => closeFeature(f.name));
  item('Delete feature…', () => deleteFeature(f), 'danger');
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${Math.max(8, rect.right - menu.offsetWidth)}px`;
  setTimeout(() => document.addEventListener('click', closeAnyMenu, { once: true }), 0);
}
function goToSession(id) { selectedId = id; setView('work'); }
function startFeatureSession(f) {
  return withPending(f.name, async () => {
    try {
      const r = await api('POST', '/api/group/session', { group: f.name });
      if (r.session) { selectedId = r.session.id; toast(r.existed ? 'Session already open — “Go to session ▸”' : `Session started for ${f.name} — “Go to session ▸”`); }
    } catch (e) { toast(e.message, true); }
  });
}

// run an async fleet action with a visible pending state keyed by `key`
async function withPending(key, fn) {
  fleetPending.add(key); if (view === 'fleet') renderFleet();
  try { return await fn(); } finally { fleetPending.delete(key); if (view === 'fleet') renderFleet(); }
}

function runStack(name) {
  return withPending(name, async () => {
    try {
      const r = await api('POST', '/api/group/start', { group: name });
      if (r.needsConfirm) {
        const names = [...new Set(r.conflicts.map((c) => c.wtname))];
        const list = names.map((n) => `“${n}”`).join(', ');
        if (!(await uiConfirm(`${list} ${names.length > 1 ? 'are' : 'is'} already running in the same repo. Stop ${names.length > 1 ? 'them' : 'it'} and switch to “${name}”?`, { title: 'Stop & switch?', okLabel: 'Stop & switch' }))) return;
        const r2 = await api('POST', '/api/group/start', { group: name, stopConflicts: true });
        toast(`Switched — started ${r2.started}/${r2.total}`);
      } else {
        toast(`Started ${r.started}/${r.total}` + (r.failures && r.failures.length ? ` (${r.failures.length} failed)` : ''), r.failures && r.failures.length);
      }
    } catch (e) { toast(e.message, true); }
  });
}
function stopStack(name) { return withPending(name, async () => { try { await api('POST', '/api/group/stop', { group: name }); toast(`Stopped ${name}`); } catch (e) { toast(e.message, true); } }); }
function restartStack(name) { return withPending(name, async () => { try { await api('POST', '/api/group/restart', { group: name }); toast(`Restarting ${name}`); } catch (e) { toast(e.message, true); } }); }
async function openGroup(name) { try { await api('POST', '/api/group/open', { group: name }); } catch (e) { toast(e.message, true); } }
function prFeature(name) {
  return withPending(name, async () => {
    try {
      toast('Opening PR / MR…');
      const r = await api('POST', '/api/group/pr', { group: name });
      const html = (r.results || []).map((x) => x.url
        ? `<div>${esc(x.repo)}: <a href="${esc(x.url)}" target="_blank" rel="noreferrer" class="link">${esc(x.url)}</a></div>`
        : `<div>${esc(x.repo)}: <span style="color:var(--waiting)">${esc(x.error)}</span></div>`).join('');
      await uiDialog({ title: 'Pull / merge requests', messageHtml: html || 'No results', okLabel: 'Done', cancelLabel: '' });
    } catch (e) { toast(e.message, true); }
  });
}
async function closeFeature(name) {
  if (!(await uiConfirm(`Close feature “${name}”? Stops its servers and deactivates its sessions (worktrees kept).`, { title: 'Close feature', okLabel: 'Close' }))) return;
  return withPending(name, async () => { try { await api('POST', '/api/group/close', { group: name }); toast(`Closed ${name}`); } catch (e) { toast(e.message, true); } });
}
async function deleteFeature(f) {
  const ms = f.members.filter((m) => m && !m.missing);
  const anyMerged = ms.some((m) => m.merged);
  const r0 = await uiDialog({ title: `Delete feature “${f.name}”?`, message: `Kills its sessions and removes its worktree(s) in ${ms.length} repo(s).`, fields: [{ type: 'checkbox', label: 'Also delete the branches', value: anyMerged }], okLabel: 'Delete', danger: true });
  if (!r0) return;
  return withPending(f.name, async () => { try { const r = await api('POST', '/api/group/delete', { group: f.name, deleteBranches: r0[0] }); toast(r.ok ? `Deleted ${f.name}` : 'Some removals failed', !r.ok); } catch (e) { toast(e.message, true); } });
}
async function removeWorktree(m) {
  const r0 = await uiDialog({ title: `Remove worktree ${m.repo}/${m.wtname}?`, message: m.merged ? 'This branch is merged into the default branch.' : 'Removes the worktree (the branch is kept unless you check below).', fields: [{ type: 'checkbox', label: `Also delete branch ${m.branch}`, value: !!m.merged }], okLabel: 'Remove', danger: true });
  if (!r0) return;
  try { const r = await api('DELETE', '/api/worktrees', { repo: m.repo, worktreePath: m.path, branch: m.branch, deleteBranch: r0[0] }); toast(r.ok ? 'Worktree removed' : r.error, !r.ok); } catch (e) { toast(e.message, true); }
}
function adoptWorktree(m) {
  // don't yank the user out of Fleet — start it with a visible pending state and
  // let them switch to Work when ready (the feature stays put in the list)
  return withPending(`adopt:${m.path}`, async () => {
    try {
      const s = await api('POST', '/api/worktrees/adopt', { repo: m.repo, worktreePath: m.path, branch: m.branch, wtname: m.wtname });
      selectedId = s.id;
      toast(`Session started in ${m.repo}/${m.wtname} — open it in Work ▸`);
    } catch (e) { toast(e.message, true); }
  });
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
      <label>Repo roots <span class="hint">— folders scanned for your repos (one per line)</span></label>
      <textarea id="setBaseDirs" class="textarea" rows="3" placeholder="~/Desktop/ab-code">${esc((data.baseDirs || []).join('\n'))}</textarea>
    </div>
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
  const baseDirs = $('#setBaseDirs').value.split('\n').map((s) => s.trim()).filter(Boolean);
  try { await api('POST', '/api/settings', { sources, baseDirs }); closeSettings(); toast('Settings saved'); } catch (e) { toast(e.message, true); }
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
