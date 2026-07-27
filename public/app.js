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

// overlay focus management — the trap cleanup fn + the element focused before open,
// restored on close, so keyboard focus returns where it was (one pair per overlay).
let modalTrap = null, modalPrevFocus = null;
let settingsTrap = null, settingsPrevFocus = null;

// terminal state
let term = null, fit = null, ws = null, ro = null;

// split-view second pane — an independent working shell (own xterm + socket) in the
// CURRENT session's worktree, via a standalone `-split` tmux session. It is NOT the
// Claude pane, so nothing is mirrored. Only ever touched through openSecondTerm/
// closeSecondTerm; the primary pane above never learns it exists.
let splitOn = false;                    // is the split toggle engaged for the current session?
const splitSessions = new Set();        // session ids marked split — persists across session switches
let term2 = null, fit2 = null, ws2 = null, ro2 = null;

// attention notifications: previous per-session state (id → state) so we can diff
// each SSE tick and alert when a session transitions INTO waiting (or idle).
const prevSessionState = new Map();
let notifyPrefs = { waiting: true, sound: true, idle: false };
let baseTitle = null;   // the document title with no waiting-count prefix
let audioCtx = null;    // lazily created on first beep (needs a user gesture)

// dock view state — the tmux terminal ('term') vs the DOM Changes ('changes') /
// Logs ('logs') panels. Switching away from 'term' hides #termWrap without
// destroying the live terminal.
let dockView = 'term';
let activeTab = 0;
let changesState = null;   // { repos:[{repo,worktreePath,base,files:[…]}] } for the selected session
let changesSel = null;     // { repo, file } — the diff currently shown
const changesUnstaged = new Set(); // ckey()s the user has un-checked (default = staged)
let changesRefreshT = null;

// live logs (poll-based tail) state
let logsSel = null;                 // worktreePath currently being tailed
let logsFollow = true;              // autoscroll to bottom when near the bottom
let logsPollT = null;               // self-scheduling poll timer
const logsOffset = new Map();       // worktreePath → next byte offset to fetch from
const logsPartial = new Map();      // worktreePath → trailing partial (incomplete) line

// PR/CI status (serverbar pill) — lazily fetched per promoted session, refreshed
// on a self-scheduling timer while that session stays selected.
let ciPollT = null;
let ciData = null;                  // { sessionId, repos:[…] } — last CI response for the selected session

const $ = (sel) => document.querySelector(sel);
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Make a click-only span/div keyboard-operable: focusable, role=button (unless one
// is already set), and Enter/Space activate. ADDITIVE — the existing click still
// fires. The e.target===el guard means a focusable descendant (e.g. a .cfile's
// checkbox, or a tab's ✕ close) handles its own keys without double-firing here.
function activatable(el, fn) {
  if (!el) return el;
  el.setAttribute('tabindex', '0');
  if (!el.getAttribute('role')) el.setAttribute('role', 'button');
  el.addEventListener('click', fn);
  el.addEventListener('keydown', (e) => {
    if (e.target !== el) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); }
  });
  return el;
}

// Tab-focusable descendants of an open overlay, in DOM order (visible ones only).
const FOCUSABLE_SEL = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
function focusablesIn(container) {
  return [...container.querySelectorAll(FOCUSABLE_SEL)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}
// Trap Tab / Shift+Tab within `container` so focus can't reach the background while
// an overlay is open. Returns a cleanup fn that removes the listener.
function trapFocus(container) {
  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const items = focusablesIn(container);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  container.addEventListener('keydown', onKey);
  return () => container.removeEventListener('keydown', onKey);
}

// The browsable frontends of a feature/session: every web repo (config.webRepos)
// that's running with a discovered port. Returns an array of { repo, port } (first
// port each) — one "Open <repo> ↗" button is rendered per entry.
function webAppsFor(list) {
  const web = new Set(state.webRepos || []);
  const out = [];
  for (const r of (list || [])) {
    if (web.has(r.repo) && r.running && (r.ports || []).length) out.push({ repo: r.repo, port: r.ports[0] });
  }
  return out;
}
function openApp(port) { window.open(`http://localhost:${port}`, '_blank', 'noopener'); }

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
  let stack = $('#toastStack');
  if (!stack) { stack = h('<div class="toast-stack" id="toastStack"></div>'); document.body.appendChild(stack); }
  const t = h(`<div class="toast ${isErr ? 'err' : ''}">${esc(msg)}</div>`);
  stack.appendChild(t);
  setTimeout(() => t.remove(), isErr ? 6000 : 3200);
}

// Disable a button while an async action runs (prevents double-fire), restoring
// state — and its label, if a pendingLabel was shown — in a finally.
async function guardBtn(btn, fn, pendingLabel) {
  if (!btn || btn.disabled) return;
  const prevLabel = pendingLabel != null ? btn.textContent : null;
  btn.disabled = true;
  if (pendingLabel != null) btn.textContent = pendingLabel;
  try { return await fn(); }
  finally { btn.disabled = false; if (prevLabel != null) btn.textContent = prevLabel; }
}

/* ---------------- custom dialogs (no native alert/confirm/prompt) ---------------- */
function uiDialog({ title, message, messageHtml, fields = [], okLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const back = h('<div class="modal-backdrop"></div>');
    const modal = h('<div class="modal dlg" role="dialog" aria-modal="true"></div>');
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
    const untrap = trapFocus(back);
    const readFields = () => [...modal.querySelectorAll('.dlgf')].map((el) => (el.dataset.t === 'checkbox' ? el.checked : el.value));
    let onKey;
    const done = (val) => { document.removeEventListener('keydown', onKey); untrap(); back.remove(); if (prevFocus && prevFocus.focus) prevFocus.focus(); resolve(val); };
    onKey = (e) => { if (e.key === 'Escape') done(null); else if (e.key === 'Enter' && !fields.some((f) => f.type === 'select')) { e.preventDefault(); done(fields.length ? readFields() : true); } };
    document.addEventListener('keydown', onKey);
    const cancelBtn = modal.querySelector('.dlg-cancel'); if (cancelBtn) cancelBtn.onclick = () => done(null);
    modal.querySelector('.dlg-ok').onclick = () => done(fields.length ? readFields() : true);
    back.addEventListener('click', (e) => { if (e.target === back) done(null); });
    const first = modal.querySelector('.dlgf');
    setTimeout(() => { const f = first || modal.querySelector('.dlg-ok'); if (f && f.focus) { f.focus(); if (f.select) f.select(); } }, 30);
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
  ev.onmessage = (e) => {
    try {
      const next = JSON.parse(e.data);
      detectAttention(next); // diff old vs new BEFORE swapping in the new state
      state = next;
      render();
    } catch { /* */ }
  };
  ev.onerror = () => { /* browser auto-reconnects */ };
}

/* ---------------- attention notifications ---------------- */
// Diff the incoming sessions against the last-seen per-session state. A session
// only alerts on a real transition INTO waiting/idle from a *known* different
// state — a session first seen on this tick (initial snapshot, or freshly
// created) is only recorded, never alerted, so the initial populate is silent.
function detectAttention(next) {
  const sessions = (next && next.sessions) || [];
  const seen = new Set();
  for (const s of sessions) {
    seen.add(s.id);
    const prev = prevSessionState.get(s.id);
    if (prev !== undefined && prev !== s.state) {
      if (s.state === 'waiting') fireAttention(s, 'waiting');
      else if (s.state === 'idle' && notifyPrefs.idle) fireAttention(s, 'idle');
    }
    prevSessionState.set(s.id, s.state);
  }
  for (const id of [...prevSessionState.keys()]) if (!seen.has(id)) prevSessionState.delete(id);
  updateAttentionUI(sessions);
}

// Always-on visual: tab-title prefix + Fleet button badge, both = # waiting.
function updateAttentionUI(sessions) {
  if (baseTitle === null) baseTitle = document.title;
  const n = sessions.filter((s) => s.state === 'waiting').length;
  document.title = n > 0 ? `● (${n}) ${baseTitle}` : baseTitle;
  const fleetBtn = document.querySelector('#viewSeg button[data-view="fleet"]');
  if (fleetBtn) fleetBtn.setAttribute('data-n', String(n));
}

// A single alert = optional desktop notification + optional sound, each gated by
// its own pref. The visual (updateAttentionUI) is separate and always fires.
function fireAttention(s, kind) {
  const wantDesktop = kind === 'waiting' ? notifyPrefs.waiting : notifyPrefs.idle;
  if (wantDesktop) showDesktopNotification(s, kind);
  if (notifyPrefs.sound) playBeep();
}

function showDesktopNotification(s, kind) {
  if (!('Notification' in window)) return;
  // already watching this session — the tab title/badge is enough
  if (s.id === selectedId && document.hasFocus()) return;
  if (Notification.permission === 'denied') return;
  const fire = () => {
    const title = kind === 'waiting' ? `${s.repoName} needs your input` : `${s.repoName} — turn complete`;
    const body = s.activity || s.title || '';
    try {
      const n = new Notification(title, { body, tag: `wts-${s.id}` });
      n.onclick = () => { selectedId = s.id; setView('work'); window.focus(); n.close(); };
    } catch { /* */ }
  };
  if (Notification.permission === 'granted') fire();
  else Notification.requestPermission().then((p) => { if (p === 'granted') fire(); }).catch(() => {});
}

// Short (~120ms) WebAudio beep. The context is created lazily and may be
// suspended until a user gesture — degrade silently if it can't play.
function playBeep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const t0 = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.14, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.13);
  } catch { /* no audio — silent */ }
}

async function loadNotifyPrefs() {
  try { const d = await api('GET', '/api/settings'); if (d && d.notify) notifyPrefs = { ...notifyPrefs, ...d.notify }; } catch { /* */ }
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

// Group sessions the way the rail displays them: promoted sessions clustered by
// their worktree (feature), unpromoted ones loose after. Shared by renderRail and
// railOrderedSessions so ⌘1…⌘9 select the Nth card in visual order.
function groupRail(sessions) {
  const byFeature = new Map();
  const loose = [];
  for (const s of sessions) {
    if (s.worktree) { if (!byFeature.has(s.worktree)) byFeature.set(s.worktree, []); byFeature.get(s.worktree).push(s); }
    else loose.push(s);
  }
  return { byFeature, loose };
}
function railOrderedSessions() {
  const { byFeature, loose } = groupRail(visibleSessions());
  return [...[...byFeature.values()].flat(), ...loose];
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
        ${s.sourceUrl ? `<a class="link" href="${esc(s.sourceUrl)}" target="_blank" rel="noreferrer">${esc(labelForSource(s))}</a>` : ''}
        ${promoted ? (s.repos && s.repos.length ? s.repos.map((r) => `<span class="grp">${esc(r.repo)}</span>`).join('') : `<span class="grp">${esc(s.repoName)}</span>`) : `<span class="grp">main</span>`}
      </div>
      <div class="scard-act">${esc(s.activity || '')}</div>
    </div>`);
  activatable(card, () => selectSession(s.id));
  // real link — don't let its click also select the card
  const srcLink = card.querySelector('a.link');
  if (srcLink) srcLink.addEventListener('click', (e) => e.stopPropagation());
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
  const { byFeature, loose } = groupRail(sessions);
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
  if (!s) { destroyTerminal(); stopLogsPoll(); stopCiPoll(); renderedDockId = null; dock.innerHTML = ''; dock.appendChild(emptyState()); return; }
  if (renderedDockId !== s.id) { rebuildDock(s); renderedDockId = s.id; }
  else updateDock(s);
}

function emptyState() {
  const e = h(`<div class="empty">
    <div class="empty-glyph">⎇</div><h2>No session selected</h2>
    <p>Start one from any source — free text, a GitHub / GitLab issue, or an Asana task. It boots a real Claude&nbsp;Code session on your CLAUDE.md, and you promote it to a worktree when it&rsquo;s real work.</p>
    <button class="btn primary">+ New session</button></div>`);
  e.querySelector('button').addEventListener('click', openModal);
  return e;
}

function rebuildDock(s) {
  destroyTerminal();
  stopLogsPoll();
  stopCiPoll();
  ciData = null;
  // reset the client-side dock view whenever the selected session changes
  dockView = 'term'; activeTab = 0;
  // split persists per session: restore it if this session was left split
  splitOn = splitSessions.has(s.id);
  changesState = null; changesSel = null; changesUnstaged.clear();
  logsSel = null; logsOffset.clear(); logsPartial.clear();
  clearTimeout(changesRefreshT);
  const dock = $('#dock');
  dock.innerHTML = '';
  dock.appendChild(h(`<div class="dock-head" id="dockHead"></div>`));
  dock.appendChild(h(`<div class="tabstrip" id="dockTabs"></div>`));
  dock.appendChild(h(`<div class="term-area" id="termArea"><div class="term-wrap" id="termWrap"></div></div>`));
  dock.appendChild(h(`<div class="changes" id="changesPanel" hidden></div>`));
  dock.appendChild(h(`<div class="logs" id="logsPanel" hidden></div>`));
  dock.appendChild(h(`<div class="serverbar" id="serverBar"></div>`));
  updateDock(s);
  openTerminal(s);
  // eager-load so the ✎ Changes badge shows a count before the tab is opened
  if (s.worktreePath) { refreshChanges(s, {}); startCiPoll(s); }
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
    b.addEventListener('click', () => guardBtn(b, () => promote(s)));
    acts.appendChild(b);
  } else {
    const oc = h(`<button class="btn sm">Open in editor</button>`);
    oc.addEventListener('click', () => openEditor(s.worktreePath));
    acts.appendChild(oc);
  }
  const po = h(`<button class="btn sm" aria-label="Pop out">Pop out ⧉</button>`);
  po.addEventListener('click', () => guardBtn(po, () => popout(s)));
  acts.appendChild(po);
  const ren = h(`<button class="btn sm ghost" title="Rename" aria-label="Rename">✐</button>`);
  ren.addEventListener('click', () => renameSession(s));
  acts.appendChild(ren);
  if (s.active === false) {
    const act = h(`<button class="btn sm">Resume</button>`);
    act.addEventListener('click', () => guardBtn(act, () => activateSession(s)));
    acts.appendChild(act);
  } else {
    const de = h(`<button class="btn sm ghost" title="Stop the process but keep the session (resumable)">Deactivate</button>`);
    de.addEventListener('click', () => guardBtn(de, () => deactivateSession(s)));
    acts.appendChild(de);
  }
  const del = h(`<button class="btn sm ghost" title="Delete session (kills the multiplexer session)" aria-label="Delete session">🗑</button>`);
  del.addEventListener('click', () => closeSession(s));
  acts.appendChild(del);

  // tabs
  renderTabstrip(s);

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
    // Port chips are plain display-only text (`repo :port`). The frontend is reached
    // solely via the prominent "Open <repo> ↗" button below (webAppsFor).
    bar.innerHTML = '<span>workspace</span>'
      + reps.map((r) => (r.running && r.ports.length
        ? r.ports.map((p) => `<span class="portchip"><span class="dot done" title="running"></span>${esc(r.repo)} :${esc(p)}</span>`).join('')
        : `<span class="portchip"><span class="dot ${r.running ? 'done' : 'idle'}" title="${r.running ? 'running' : 'stopped'}"></span>${esc(r.repo)}</span>`)).join('')
      + '<span class="spacer" style="flex:1"></span>';
    for (const web of webAppsFor(reps)) { const b = h(`<button class="btn sm primary" title="Open the frontend — http://localhost:${esc(web.port)}">Open ${esc(web.repo)} ↗</button>`); b.addEventListener('click', () => openApp(web.port)); bar.appendChild(b); }
    if (anyStopped) { const b = h(`<button class="btn sm go">${anyRunning ? 'Run rest' : 'Run all'}</button>`); b.addEventListener('click', () => guardBtn(b, () => startSessionServers(s))); bar.appendChild(b); }
    if (anyRunning) { const b = h('<button class="btn sm danger">Stop all</button>'); b.addEventListener('click', () => guardBtn(b, () => stopSessionServers(s))); bar.appendChild(b); }
  }
  // Re-inject any cached PR/CI pills (updateDock rebuilds the bar on every SSE tick).
  if (promoted) injectCiPills(s);

  applyDockView();
  // an SSE tick arrived while the Changes panel is open — refresh the file list
  // (debounced) without stomping the diff the user is reading.
  if (dockView === 'changes') scheduleChangesRefresh(s);
}

/* ---------------- PR / CI status pill ---------------- */
function stopCiPoll() { if (ciPollT) { clearTimeout(ciPollT); ciPollT = null; } }

// Lazily fetch PR/CI status for a promoted session, then refresh every ~30s while
// it stays selected. Never blocks the serverbar render; degrades to nothing on error.
function startCiPoll(s) {
  stopCiPoll();
  if (!s.worktreePath) return;
  const tick = async () => {
    if (selectedId !== s.id) { stopCiPoll(); return; }
    try {
      const res = await api('GET', `/api/sessions/${s.id}/ci`);
      if (selectedId !== s.id) { stopCiPoll(); return; }
      ciData = { sessionId: s.id, repos: (res && res.repos) || [] };
      injectCiPills(s);
    } catch { /* no gh/glab, no PR, network error — leave the bar as-is */ }
    if (selectedId === s.id) ciPollT = setTimeout(tick, 30000); else stopCiPoll();
  };
  tick();
}

// Build one clickable .cistat pill for a repo that has a PR/MR.
function ciPill(r) {
  const c = r.checks || { passed: 0, running: 0, failed: 0, total: 0 };
  const tag = (r.provider === 'gitlab' ? '!' : '#') + esc(r.number);
  const parts = [];
  if (c.total === 0) {
    if (r.state) parts.push(`<span class="ck">${esc(String(r.state).toLowerCase())}</span>`);
  } else {
    if (c.passed) parts.push(`<span class="ck ok">✓${esc(c.passed)}</span>`);
    if (c.running) parts.push(`<span class="ck run">◴${esc(c.running)}</span>`);
    if (c.failed) parts.push(`<span class="ck x">✕${esc(c.failed)}</span>`);
  }
  const el = h(`<span class="cistat" title="Open ${r.provider === 'gitlab' ? 'MR' : 'PR'} ${tag}"><span>${esc(r.repo)} ${tag}</span>${parts.join('')}</span>`);
  if (r.url) activatable(el, () => window.open(r.url, '_blank', 'noopener'));
  return el;
}

// Render cached CI pills into the serverbar (before the spacer, else appended).
// No-op unless the cached data belongs to the currently shown session.
function injectCiPills(s) {
  const bar = $('#serverBar');
  if (!bar) return;
  bar.querySelectorAll('.cistat').forEach((el) => el.remove());
  if (!ciData || ciData.sessionId !== s.id) return;
  const spacer = bar.querySelector('.spacer');
  for (const r of ciData.repos) {
    if (!r || !r.hasPR) continue;
    const pill = ciPill(r);
    if (spacer) bar.insertBefore(pill, spacer); else bar.appendChild(pill);
  }
}

/* ---------------- changes / diff panel ---------------- */
const ckey = (repo, file) => `${repo} ${file}`;

function renderTabstrip(s) {
  const tabs = $('#dockTabs');
  if (!tabs) return;
  tabs.innerHTML = '';
  const tabList = s.tabs || [{ title: 'claude' }];
  tabList.forEach((t, i) => {
    const closable = tabList.length > 1; // any tab can be closed when more than one
    const on = dockView === 'term' && i === activeTab;
    const tab = h(`<span class="tab ${on ? 'on' : ''}"><span class="dot ${on ? s.state : 'idle'}" title="${esc(on ? s.state : 'idle')}"></span>${esc(t.title)}${closable ? ' <span class="tabclose" title="Close tab" aria-label="Close tab">✕</span>' : ''}</span>`);
    activatable(tab, () => selectTab(s, i));
    const x = tab.querySelector('.tabclose');
    if (x) activatable(x, (e) => { if (e) e.stopPropagation(); closeTab(s, i); });
    tabs.appendChild(tab);
  });
  // ✎ Changes — a DOM panel, not a tmux window. Only for promoted (worktree) sessions.
  if (s.worktreePath) {
    const n = changesFileCount();
    const on = dockView === 'changes';
    const ct = h(`<span class="tab ${on ? 'on' : ''}">✎ Changes${n ? ` <span class="cbadge">${esc(n)}</span>` : ''}</span>`);
    activatable(ct, () => openChanges(s));
    tabs.appendChild(ct);
    // ▤ Logs — live dev-server tail (poll-based). Also worktree-only.
    const lt = h(`<span class="tab ${dockView === 'logs' ? 'on' : ''}">▤ Logs</span>`);
    activatable(lt, () => openLogs(s));
    tabs.appendChild(lt);
  }
  const add = h(`<span class="tab" aria-label="New tab"><span class="newtab">＋</span></span>`);
  activatable(add, () => guardBtn(add, () => addTab(s)));
  tabs.appendChild(add);
  const pop = h(`<button class="btn xs popout" aria-label="Pop out">Pop out ⧉</button>`);
  pop.addEventListener('click', () => guardBtn(pop, () => popout(s)));
  tabs.appendChild(pop);
  // ⊟ Split — second live terminal beside the primary. Only meaningful in the
  // term view, so it only appears there.
  if (dockView === 'term') {
    const sp = h(`<button class="btn xs split-toggle ${splitOn ? 'on' : ''}" title="Open an independent working shell in this worktree, beside the Claude terminal">⊟ Split</button>`);
    sp.addEventListener('click', () => {
      splitOn = !splitOn;
      if (splitOn) splitSessions.add(s.id); else splitSessions.delete(s.id);
      applySplit(); renderTabstrip(s);
    });
    tabs.appendChild(sp);
  }
}

function applyDockView() {
  const ta = $('#termArea'); const cp = $('#changesPanel'); const lp = $('#logsPanel');
  if (ta) ta.hidden = dockView !== 'term';
  if (cp) cp.hidden = dockView !== 'changes';
  if (lp) lp.hidden = dockView !== 'logs';
  // Reconcile the split pane: it only lives while the term view is showing, so
  // leaving for Changes/Logs tears it down and returning rebuilds it.
  applySplit();
}

function changesFileCount() {
  if (!changesState || !changesState.repos) return 0;
  return changesState.repos.reduce((n, r) => n + ((r.files && r.files.length) || 0), 0);
}
// flat [{repo, file, status, added, deleted}] across every repo
function allChangeFiles() {
  const out = [];
  for (const r of (changesState && changesState.repos) || []) {
    for (const f of r.files || []) out.push({ repo: r.repo, ...f });
  }
  return out;
}
function branchForRepo(s, repoName) {
  const e = (s.repos || []).find((r) => r.repo === repoName);
  return (e && e.branch) || s.branch || '';
}
function statusFor(repo, file) {
  const f = allChangeFiles().find((x) => x.repo === repo && x.file === file);
  return (f && f.status ? f.status : 'M').toUpperCase();
}

function openChanges(s) {
  stopLogsPoll();
  dockView = 'changes';
  renderTabstrip(s);
  applyDockView();
  renderChangesPanel(s);
  refreshChanges(s, { force: true });
}

function scheduleChangesRefresh(s) {
  clearTimeout(changesRefreshT);
  changesRefreshT = setTimeout(() => { if (selectedId === s.id && dockView === 'changes') refreshChanges(s, {}); }, 400);
}

async function refreshChanges(s, opts = {}) {
  try {
    const data = await api('GET', `/api/sessions/${s.id}/changes`);
    if (selectedId !== s.id) return;
    changesState = data;
    renderTabstrip(s); // refresh the ✎ Changes badge count
    if (dockView !== 'changes' || !$('#changesFiles')) return;
    renderChangesFiles(s);
    renderCommitMeta();
    const files = allChangeFiles();
    const stillThere = changesSel && files.some((f) => f.repo === changesSel.repo && f.file === changesSel.file);
    if (opts.force || !stillThere) {
      if (files.length) selectDiff(s, files[0].repo, files[0].file);
      else { changesSel = null; renderDiffEmpty(); }
    } else if (opts.reloadCurrent) {
      selectDiff(s, changesSel.repo, changesSel.file);
    }
  } catch (e) { if (dockView === 'changes') toast(e.message, true); }
}

function renderChangesPanel(s) {
  const panel = $('#changesPanel');
  if (!panel) return;
  panel.innerHTML = `
    <div class="changes-cols">
      <div class="changes-files" id="changesFiles"></div>
      <div class="changes-diff" id="changesDiff"></div>
    </div>
    <div class="commitbar">
      <div class="commit-meta">
        <span id="commitStat"></span>
        <span class="spacer" style="flex:1"></span>
        <span class="refresh" id="changesRefresh" title="Reload changes">⟳ Refresh</span>
      </div>
      <div class="commit-row">
        <input class="commit-input" id="commitMsg" placeholder="Commit message…" />
      </div>
      <div class="commit-row">
        <label class="chk"><input type="checkbox" id="commitAmend"> amend</label>
        <span class="spacer" style="flex:1"></span>
        <button class="btn sm" id="commitBtn">Commit</button>
        <button class="btn sm go" id="commitPrBtn">Commit &amp; open PR ↗</button>
      </div>
    </div>`;
  activatable($('#changesRefresh'), () => refreshChanges(s, { reloadCurrent: true }));
  $('#commitBtn').addEventListener('click', () => doCommit(s, false));
  $('#commitPrBtn').addEventListener('click', () => doCommit(s, true));
  renderChangesFiles(s);
  renderDiffEmpty();
  renderCommitMeta();
}

function renderChangesFiles(s) {
  const el = $('#changesFiles');
  if (!el) return;
  el.innerHTML = '';
  const repos = (changesState && changesState.repos) || [];
  if (!repos.length) { el.appendChild(h(`<div class="chsub">No changes vs the base branch.</div>`)); return; }
  for (const r of repos) {
    const branch = branchForRepo(s, r.repo);
    el.appendChild(h(`<div class="chsub">${esc(r.repo)}${branch ? ` · branch ${esc(branch)}` : ''}</div>`));
    if (!(r.files && r.files.length)) { el.appendChild(h(`<div class="chsub clean">clean</div>`)); continue; }
    for (const f of r.files) {
      const key = ckey(r.repo, f.file);
      const staged = !changesUnstaged.has(key);
      const sel = changesSel && changesSel.repo === r.repo && changesSel.file === f.file;
      const st = (f.status || 'M').toUpperCase();
      const stc = st === 'A' ? 'a' : st === 'D' ? 'd' : 'm';
      const row = h(`<div class="cfile ${sel ? 'on' : ''}">
        <input type="checkbox" ${staged ? 'checked' : ''}>
        <span class="st ${stc}">${esc(st)}</span>
        <span class="nm" title="${esc(f.file)}">${esc(f.file)}</span>
        ${f.added ? `<span class="adds">+${esc(f.added)}</span>` : ''}
        ${f.deleted ? `<span class="dels">−${esc(f.deleted)}</span>` : ''}
      </div>`);
      const cb = row.querySelector('input');
      cb.setAttribute('aria-label', `Stage ${f.file}`);
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('keydown', (e) => e.stopPropagation()); // let the checkbox own its keys; don't reach the row
      cb.addEventListener('change', () => { if (cb.checked) changesUnstaged.delete(key); else changesUnstaged.add(key); renderCommitMeta(); });
      activatable(row, () => selectDiff(s, r.repo, f.file));
      el.appendChild(row);
    }
  }
}

function renderDiffEmpty() {
  const box = $('#changesDiff');
  if (box) box.innerHTML = `<div class="diff-empty">Select a file to view its diff.</div>`;
}

async function selectDiff(s, repo, file) {
  changesSel = { repo, file };
  renderChangesFiles(s); // move the .on highlight
  const box = $('#changesDiff');
  if (!box) return;
  box.innerHTML = `<div class="diff-fname">${esc(file)} <span class="pill idle">loading…</span></div>`;
  try {
    const res = await api('GET', `/api/sessions/${s.id}/diff?repo=${encodeURIComponent(repo)}&file=${encodeURIComponent(file)}`);
    if (!(changesSel && changesSel.repo === repo && changesSel.file === file)) return; // a newer click won
    renderDiff(box, repo, file, (res && res.raw) || '');
  } catch (e) {
    box.innerHTML = `<div class="diff-fname">${esc(file)}</div><div class="diffline ctx"><span class="ln"></span><span class="tx">${esc(e.message)}</span></div>`;
  }
}

// Parse a raw unified diff line-by-line: @@=hunk, +=add, -=del, else context.
// Header lines (diff --git / index / +++ / --- / mode / rename …) are dropped.
const MAX_DIFF_LINES = 3000;
function renderDiff(box, repo, file, text) {
  const status = statusFor(repo, file);
  const label = status === 'A' ? 'Added' : status === 'D' ? 'Deleted' : 'Modified';
  const head = `<div class="diff-fname">${esc(file)} <span class="pill idle">${esc(label)}</span></div>`;
  const skip = /^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|old mode |new mode |similarity index|dissimilarity index|rename from |rename to |copy from |copy to |Binary files )/;
  const out = [];
  let oldLn = 0, newLn = 0;
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (skip.test(raw)) continue;
    // cap unbounded DOM growth on huge diffs — render the first N, then a notice
    if (out.length >= MAX_DIFF_LINES) {
      let more = 0;
      for (let j = i; j < lines.length; j++) if (!skip.test(lines[j])) more++;
      out.push(`<div class="diffline ctx"><span class="ln"></span><span class="tx">… diff truncated (${esc(more)} more lines) — open in editor to see the rest</span></div>`);
      break;
    }
    if (raw.startsWith('@@')) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { oldLn = +m[1]; newLn = +m[2]; }
      out.push(`<div class="diffline hunk"><span class="ln"></span><span class="tx">${esc(raw)}</span></div>`);
      continue;
    }
    if (raw.startsWith('\\')) { // "\ No newline at end of file"
      out.push(`<div class="diffline ctx"><span class="ln"></span><span class="tx">${esc(raw)}</span></div>`);
      continue;
    }
    let cls = 'ctx', ln = '';
    if (raw.startsWith('+')) { cls = 'add'; ln = String(newLn++); }
    else if (raw.startsWith('-')) { cls = 'del'; ln = String(oldLn++); }
    else { ln = String(newLn); oldLn++; newLn++; }
    out.push(`<div class="diffline ${cls}"><span class="ln">${esc(ln)}</span><span class="tx">${esc(raw)}</span></div>`);
  }
  box.innerHTML = head + (out.length ? out.join('') : `<div class="diffline ctx"><span class="ln"></span><span class="tx">(no textual diff)</span></div>`);
}

function renderCommitMeta() {
  const el = $('#commitStat');
  if (!el) return;
  const files = allChangeFiles();
  const staged = files.filter((f) => !changesUnstaged.has(ckey(f.repo, f.file)));
  const add = staged.reduce((n, f) => n + (f.added || 0), 0);
  const del = staged.reduce((n, f) => n + (f.deleted || 0), 0);
  el.innerHTML = `${staged.length} of ${files.length} file${files.length === 1 ? '' : 's'} staged · <b style="color:var(--add)">+${add}</b> <b style="color:var(--del)">−${del}</b>`;
}

// Which repo this commit targets: the selected file's repo (if it has staged
// files), else the first repo with anything staged. Commit is per-repo.
function commitRepo() {
  const staged = allChangeFiles().filter((f) => !changesUnstaged.has(ckey(f.repo, f.file)));
  if (!staged.length) return null;
  if (changesSel && staged.some((f) => f.repo === changesSel.repo)) return changesSel.repo;
  return staged[0].repo;
}
function stagedPathsForRepo(repo) {
  return allChangeFiles().filter((f) => f.repo === repo && !changesUnstaged.has(ckey(f.repo, f.file))).map((f) => f.file);
}

async function doCommit(s, openPr) {
  const input = $('#commitMsg');
  const msg = input ? input.value.trim() : '';
  if (!msg) return toast('Enter a commit message first.', true);
  const repo = commitRepo();
  if (!repo) return toast('No files staged to commit.', true);
  const paths = stagedPathsForRepo(repo);
  if (!paths.length) return toast(`No files staged for ${repo}.`, true);
  const amend = !!($('#commitAmend') && $('#commitAmend').checked);
  const btns = [$('#commitBtn'), $('#commitPrBtn')].filter(Boolean);
  btns.forEach((b) => { b.disabled = true; });
  try {
    const r = await api('POST', `/api/sessions/${s.id}/commit`, { repo, message: msg, paths, amend });
    if (!r.ok) throw new Error(r.error || 'commit failed');
    toast(`Committed ${repo}${r.sha ? ` @ ${r.sha.slice(0, 7)}` : ''}`);
    if (input) input.value = '';
    if (openPr) {
      toast('Opening PR / MR…');
      const pr = await api('POST', '/api/group/pr', { group: s.feature });
      const html = (pr.results || []).map((x) => x.url
        ? `<div>${esc(x.repo)}: <a href="${esc(x.url)}" target="_blank" rel="noreferrer" class="link">${esc(x.url)}</a></div>`
        : `<div>${esc(x.repo)}: <span style="color:var(--waiting)">${esc(x.error)}</span></div>`).join('');
      await uiDialog({ title: 'Pull / merge requests', messageHtml: html || 'No results', okLabel: 'Done', cancelLabel: '' });
    }
    await refreshChanges(s, { force: true });
  } catch (e) { toast(e.message, true); }
  finally { btns.forEach((b) => { b.disabled = false; }); }
}

/* ---------------- live logs panel ---------------- */
// Repos of the selected session that own a worktree (each has a per-worktree log
// file once its dev server has been started). Carries { repo, worktreePath, running, ports }.
function logsRepos(s) { return (state.servers[s.id] && state.servers[s.id].repos) || []; }

function openLogs(s) {
  dockView = 'logs';
  renderTabstrip(s);
  applyDockView();
  renderLogsPanel(s);
}

function renderLogsPanel(s) {
  const panel = $('#logsPanel');
  if (!panel) return;
  const reps = logsRepos(s);
  // keep the prior selection if still valid, else prefer a running server, else first
  let sel = reps.find((r) => r.worktreePath === logsSel);
  if (!sel) sel = reps.find((r) => r.running) || reps[0];
  logsSel = sel ? sel.worktreePath : null;
  const opts = reps.map((r) => {
    const ports = (r.ports && r.ports.length) ? ' ' + r.ports.map((p) => ':' + p).join(' ') : '';
    const label = `${r.repo}${ports}${r.running ? '' : ' (stopped)'}`;
    return `<option value="${esc(r.worktreePath)}" ${r.worktreePath === logsSel ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');
  panel.innerHTML = `
    <div class="logs-head">
      <span>tail</span>
      <select class="select logs-select" id="logsSelect" ${reps.length ? '' : 'disabled'}>${opts || '<option>no repos</option>'}</select>
      <label class="chk"><input type="checkbox" id="logsFollow" ${logsFollow ? 'checked' : ''}> follow</label>
      <button class="btn xs" id="logsClear">Clear</button>
      <span class="tailing" id="logsTailing" hidden><i></i>tailing</span>
    </div>
    <div class="logbody" id="logsBody"></div>`;
  const selEl = $('#logsSelect');
  if (selEl) selEl.addEventListener('change', () => startLogsPoll(s, selEl.value));
  $('#logsFollow').addEventListener('change', (e) => { logsFollow = e.target.checked; if (logsFollow) { const b = $('#logsBody'); if (b) b.scrollTop = b.scrollHeight; } });
  $('#logsClear').addEventListener('click', () => { const b = $('#logsBody'); if (b) b.innerHTML = ''; logsPartial.delete(logsSel); });
  if (logsSel) startLogsPoll(s, logsSel);
  else $('#logsBody').innerHTML = `<div class="logs-hint">Promote and start a dev server to see logs.</div>`;
}

function setTailing(on, label) {
  const el = $('#logsTailing');
  if (!el) return;
  el.hidden = !on;
  if (on) el.innerHTML = `<i></i>tailing${label ? ' ' + esc(label) : ''}`;
}

function stopLogsPoll() {
  if (logsPollT) { clearTimeout(logsPollT); logsPollT = null; }
  setTailing(false);
}

// Poll GET /api/servers/logs?worktreePath=&offset= every ~1.5s while the Logs tab
// is open for `wtPath`. A self-scheduling timeout (not setInterval) avoids
// overlapping requests that could double-append. Offset is tracked per worktree.
function startLogsPoll(s, wtPath) {
  stopLogsPoll();
  logsSel = wtPath;
  const body = $('#logsBody');
  if (!body) return;
  body.innerHTML = '';
  logsOffset.delete(wtPath);
  logsPartial.delete(wtPath);
  const opt = $('#logsSelect') && $('#logsSelect').selectedOptions[0];
  setTailing(true, opt ? opt.textContent : '');
  const alive = () => selectedId === s.id && dockView === 'logs' && logsSel === wtPath && $('#logsBody');
  const tick = async () => {
    if (!alive()) { stopLogsPoll(); return; }
    const b = $('#logsBody');
    try {
      const prev = logsOffset.get(wtPath);
      const near = (b.scrollHeight - b.scrollTop - b.clientHeight) < 60;
      const q = prev === undefined ? '' : `&offset=${prev}`;
      const res = await api('GET', `/api/servers/logs?worktreePath=${encodeURIComponent(wtPath)}${q}`);
      if (!alive()) { stopLogsPoll(); return; }
      logsOffset.set(wtPath, res.offset);
      if (res.text) {
        appendLogText(b, wtPath, res.text);
        if (logsFollow && near) b.scrollTop = b.scrollHeight;
      } else if (prev === undefined && res.size === 0 && !b.firstChild) {
        b.innerHTML = `<div class="logs-hint">No logs yet — start this feature's dev server.</div>`;
      }
    } catch { /* transient network/parse error — keep polling */ }
    if (alive()) logsPollT = setTimeout(tick, 1500);
    else stopLogsPoll();
  };
  tick();
}

// Append a text chunk, buffering the trailing partial line so a line split across
// two polls renders as one line (not two). Escapes everything.
function appendLogText(body, wtPath, chunk) {
  const hint = body.querySelector('.logs-hint'); if (hint) hint.remove();
  const oldPartial = body.querySelector('.logpartial'); if (oldPartial) oldPartial.remove();
  const combined = (logsPartial.get(wtPath) || '') + chunk;
  const lines = combined.split('\n');
  const partial = lines.pop();
  logsPartial.set(wtPath, partial);
  let html = lines.map((ln) => logLineHtml(ln, false)).join('');
  if (partial) html += logLineHtml(partial, true);
  if (html) body.insertAdjacentHTML('beforeend', html);
  // cap unbounded growth: keep only the most recent MAX_LOG_LINES line elements
  let over = body.childElementCount - MAX_LOG_LINES;
  while (over-- > 0 && body.firstChild) body.removeChild(body.firstChild);
}
const MAX_LOG_LINES = 2000;

// One escaped log line with light level coloring and a highlighted leading timestamp.
function logLineHtml(raw, partial) {
  let cls = '';
  if (/(error|fatal|exception|failed|✗|\bECONN)/i.test(raw)) cls = 'e';
  else if (/(warn|deprecated)/i.test(raw)) cls = 'w';
  else if (/(ready|listening|compiled|success|✓)/i.test(raw)) cls = 'ok';
  const ts = raw.match(/^\s*(\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?)/);
  const inner = ts
    ? `<span class="t">${esc(ts[1])}</span>${esc(raw.slice(ts[0].length))}`
    : esc(raw);
  return `<div class="logline${cls ? ' ' + cls : ''}${partial ? ' logpartial' : ''}">${inner || '&nbsp;'}</div>`;
}

/* ---------------- terminal ---------------- */
function themeForTerm() {
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  return light
    ? { background: '#12151b', foreground: '#cdd4de', cursor: '#d05f30' }
    : { background: '#0c0f14', foreground: '#cdd4de', cursor: '#e0733f' };
}

function destroyTerminal() {
  closeSecondTerm(); // never leak a ws2/term2 across a session switch or teardown
  try { if (ro) ro.disconnect(); } catch { /* */ }
  try { if (ws) { ws.onclose = null; ws.close(); } } catch { /* */ }
  try { if (term) term.dispose(); } catch { /* */ }
  ro = ws = term = fit = null;
}

// A ResizeObserver whose callback fits a terminal synchronously can retrigger itself
// in the same frame — the browser then reports "ResizeObserver loop completed with
// undelivered notifications". Coalescing to the next animation frame breaks that loop.
function rafObserver(cb) {
  let scheduled = false;
  return new ResizeObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; try { cb(); } catch { /* */ } });
  });
}

function openTerminal(s) {
  const wrap = $('#termWrap');
  if (!wrap || !XTerm) return;
  term = new XTerm({ fontFamily: 'ui-monospace, SF Mono, Menlo, monospace', fontSize: 12.5, cursorBlink: true, scrollback: 8000, allowProposedApi: true, theme: themeForTerm() });
  if (FitAddonCtor) { fit = new FitAddonCtor(); term.loadAddon(fit); }
  if (WebLinksCtor) { try { term.loadAddon(new WebLinksCtor()); } catch { /* */ } }
  term.open(wrap);
  try { fit && fit.fit(); } catch { /* */ }
  term.onData((d) => { if (ws && ws.readyState === 1) ws.send(new TextEncoder().encode(d)); });
  ro = rafObserver(() => { if (fit) { fit.fit(); sendResize(); } });
  ro.observe(wrap);
  connectTermWS(s, 0);
}

// Open (or re-open) the terminal socket for session `s`, reattaching the same
// live xterm. On an UNintended close (destroyTerminal nulls `onclose` for
// intentional ones) we retry with a capped backoff (1s→2s→4s, ~5 tries),
// which revives the pane after a server restart that manager.restore() handles.
function connectTermWS(s, attempt) {
  if (!term) return;
  const theTerm = term; // capture so a later select/dispose can stop this chain
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws/term?session=${encodeURIComponent(s.id)}&cols=${theTerm.cols}&rows=${theTerm.rows}`);
  sock.binaryType = 'arraybuffer';
  ws = sock;
  sock.onmessage = (e) => { if (typeof e.data === 'string') theTerm.write(e.data); else theTerm.write(new Uint8Array(e.data)); };
  sock.onopen = () => {
    if (term !== theTerm || selectedId !== s.id) { try { sock.close(); } catch { /* */ } return; }
    if (attempt > 0) { try { theTerm.write('\r\n\x1b[2m[reconnected]\x1b[0m\r\n'); } catch { /* */ } }
    sendResize();
    theTerm.focus();
  };
  sock.onclose = () => {
    // Reaching here means an unintended drop (intentional closes null this handler
    // first). Stop if the terminal was disposed or the selection moved on.
    if (term !== theTerm || selectedId !== s.id) return;
    if (attempt >= 5) { try { theTerm.write('\r\n\x1b[2m[disconnected — reselect to reattach]\x1b[0m\r\n'); } catch { /* */ } return; }
    try { theTerm.write('\r\n\x1b[2m[reconnecting…]\x1b[0m\r\n'); } catch { /* */ }
    const delay = Math.min(4000, 1000 * (2 ** attempt));
    setTimeout(() => { if (term === theTerm && selectedId === s.id) connectTermWS(s, attempt + 1); }, delay);
  };
}

function sendResize() {
  if (ws && ws.readyState === 1 && term) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
}

/* ---------------- split view (second, independent terminal) ---------------- */

// Reconcile the DOM to (splitOn && dockView==='term'). Idempotent: safe to call
// from the toggle, from applyDockView on every SSE tick, and on view changes.
function applySplit() {
  const ta = $('#termArea');
  if (!ta) return;
  const s = state.sessions.find((x) => x.id === selectedId);
  const want = splitOn && dockView === 'term' && !!s;
  const has = !!$('#termPane2');
  if (want && !has) {
    ta.classList.add('term-split');
    ta.appendChild(buildSecondPane());
    openSecondTerm(s);
    refitPrimary(); // primary just lost half its width — refit so it isn't stale
  } else if (!want && has) {
    closeSecondTerm();
    ta.classList.remove('term-split');
    const p = $('#termPane2'); if (p) p.remove();
    refitPrimary(); // primary reclaimed full width
  }
}

function buildSecondPane() {
  return h(`<div class="panewrap" id="termPane2">
    <div class="panehd"><span class="dot idle"></span><span class="panehd-label">shell</span></div>
    <div class="term-wrap" id="termWrap2"></div>
  </div>`);
}

// Refit the PRIMARY terminal after its width changes (entering/leaving split).
// rAF lets the grid settle first; no-op while the term view is hidden.
function refitPrimary() {
  if (!term || !fit) return;
  const ta = $('#termArea');
  if (ta && ta.hidden) return;
  requestAnimationFrame(() => { try { fit.fit(); sendResize(); } catch { /* */ } });
}

function openSecondTerm(s) {
  const wrap = $('#termWrap2');
  if (!wrap || !XTerm || !s) return;
  term2 = new XTerm({ fontFamily: 'ui-monospace, SF Mono, Menlo, monospace', fontSize: 12.5, cursorBlink: true, scrollback: 8000, allowProposedApi: true, theme: themeForTerm() });
  if (FitAddonCtor) { fit2 = new FitAddonCtor(); term2.loadAddon(fit2); }
  if (WebLinksCtor) { try { term2.loadAddon(new WebLinksCtor()); } catch { /* */ } }
  term2.open(wrap);
  try { fit2 && fit2.fit(); } catch { /* */ }
  term2.onData((d) => { if (ws2 && ws2.readyState === 1) ws2.send(new TextEncoder().encode(d)); });
  ro2 = rafObserver(() => { if (fit2) { fit2.fit(); sendResize2(); } });
  ro2.observe(wrap);
  connectSecondWS(s.id);
}

// Plain connect — no reconnect/backoff — over the standalone `-split` shell session
// (pane=split), independent of the primary. On close, a display-only notice.
function connectSecondWS(sessionId) {
  if (!term2) return;
  const theTerm = term2; // capture so a select/dispose can orphan this socket
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws/term?session=${encodeURIComponent(sessionId)}&pane=split&cols=${theTerm.cols}&rows=${theTerm.rows}`);
  sock.binaryType = 'arraybuffer';
  ws2 = sock;
  sock.onmessage = (e) => { if (typeof e.data === 'string') theTerm.write(e.data); else theTerm.write(new Uint8Array(e.data)); };
  sock.onopen = () => {
    if (term2 !== theTerm) { try { sock.close(); } catch { /* */ } return; }
    sendResize2();
  };
  sock.onclose = () => {
    if (term2 !== theTerm) return; // superseded by a newer pane — stay quiet
    try { theTerm.write('\r\n\x1b[2m[disconnected]\x1b[0m\r\n'); } catch { /* */ }
  };
}

function sendResize2() {
  if (ws2 && ws2.readyState === 1 && term2) ws2.send(JSON.stringify({ type: 'resize', cols: term2.cols, rows: term2.rows }));
}

function closeSecondTerm() {
  try { if (ro2) ro2.disconnect(); } catch { /* */ }
  try { if (ws2) { ws2.onclose = null; ws2.close(); } } catch { /* */ }
  try { if (term2) term2.dispose(); } catch { /* */ }
  ro2 = ws2 = term2 = fit2 = null;
}

/* ---------------- actions ---------------- */
async function promote(s) {
  const branch = await uiPrompt('Branch to create for this worktree:', s.suggestedBranch || 'feature/x');
  if (!branch) return;
  try {
    let r = await api('POST', `/api/sessions/${s.id}/promote`, { branch });
    // Dirty main → warn before stranding pre-promote edits (they stay in main).
    if (r.needsConfirm) {
      const n = (r.dirty || []).length;
      const ok = await uiConfirm(`Your main checkout has ${n} uncommitted change(s) that will stay in main, not move to the new worktree. Promote anyway?`, { title: 'Uncommitted changes in main', okLabel: 'Promote anyway', danger: true });
      if (!ok) return;
      r = await api('POST', `/api/sessions/${s.id}/promote`, { branch, confirm: true });
    }
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
async function selectTab(s, i) {
  stopLogsPoll();
  dockView = 'term'; activeTab = i;
  renderTabstrip(s); applyDockView();
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
  if (!(await uiConfirm(`Deactivate “${s.title}”? Stops the process; you can resume it later to continue the conversation.`, { title: 'Deactivate', okLabel: 'Deactivate' }))) return;
  try { await api('POST', `/api/sessions/${s.id}/deactivate`, {}); toast('Deactivated'); } catch (e) { toast(e.message, true); }
}
async function activateSession(s) {
  try { await api('POST', `/api/sessions/${s.id}/activate`, {}); toast('Resuming session'); } catch (e) { toast(e.message, true); }
}
// start/stop every dev server in the session's shared workspace
async function startSessionServers(s) { try { const r = await api('POST', `/api/sessions/${s.id}/servers/start`, {}); toast(r.ok ? 'Workspace servers starting' : 'Some failed to start', !r.ok); } catch (e) { toast(e.message, true); } }
async function stopSessionServers(s) { try { await api('POST', `/api/sessions/${s.id}/servers/stop`, {}); toast('Workspace servers stopped'); } catch (e) { toast(e.message, true); } }
async function openEditor(p) { try { await api('POST', '/api/open', { path: p }); } catch (e) { toast(e.message, true); } }

/* ---------------- intake modal ---------------- */
function openModal() {
  modalPrevFocus = document.activeElement;
  modal.repo = modal.repo || (state.repos[0] && state.repos[0].name) || '';
  modal.source = 'freetext'; modal.issues = []; modal.issueId = null;
  // reset the form fields each open
  if ($('#mText')) $('#mText').value = '';
  if ($('#mName')) $('#mName').value = '';
  renderModal();
  $('#modal').hidden = false;
  modalTrap = trapFocus($('#modal'));
  setTimeout(() => $('#mText') && $('#mText').focus(), 30);
}
function closeModal() {
  if ($('#modal').hidden) return; // already closed — don't stomp focus/prev refs
  $('#modal').hidden = true;
  if (modalTrap) { modalTrap(); modalTrap = null; }
  if (modalPrevFocus && modalPrevFocus.focus) modalPrevFocus.focus();
  modalPrevFocus = null;
}

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
    if (!dis) activatable(el, () => { modal.source = t.id; modal.issues = []; modal.issueId = null; renderModal(); });
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
    activatable(el, () => { modal.issueId = it.id; renderModal(); });
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
  const btn = $('#mLoad');
  if (btn) { if (btn.disabled) return; btn.disabled = true; btn.textContent = 'Loading…'; }
  try {
    const out = await api('GET', `/api/sources/${modal.source}/items?repo=${encodeURIComponent(modal.repo)}`);
    if (!out.ok) throw new Error(out.error || 'failed');
    modal.issues = out.items || [];
    if (!modal.issues.length) toast('No items found.');
  } catch (e) { toast(e.message, true); }
  if (btn) { btn.disabled = false; btn.textContent = 'Load'; }
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

// active = a live agent or a running dev server
function featActive(f) { return f.members.some((m) => m && !m.missing && (m.running || (m.session && m.session.state !== 'stopped'))); }

function renderFleet() {
  // active first, then alphabetical — a feature doesn't jump around when it starts
  const feats = (state.features || []).slice().sort((a, b) => (featActive(b) - featActive(a)) || a.name.localeCompare(b.name));
  // unpromoted sessions — surfaced here so Fleet is the one place you watch work.
  // ended/deactivated ones linger as stopped (active first, then alphabetical).
  const agents = (state.sessions || []).filter((s) => !s.worktreePath)
    .sort((a, b) => ((a.state === 'stopped') - (b.state === 'stopped')) || (a.title || '').localeCompare(b.title || ''));
  // worktree features whose dev servers are up (may also appear under Worktrees)
  const serverFeats = feats.filter((f) => f.members.some((m) => m && m.running));

  const flat = feats.flatMap((f) => f.members.filter((m) => m && !m.missing));
  const running = flat.filter((m) => m.running).length;
  const waiting = flat.filter((m) => m.session && m.session.state === 'waiting').length;
  const workingA = flat.filter((m) => m.session && m.session.state === 'working').length;

  const sum = $('#fleetSummary');
  sum.innerHTML = `
    <span><b>${feats.length}</b> features</span>
    <span class="chip"><span class="pi">✦</span>${agents.length} unpromoted</span>
    <span class="chip"><span class="dot done"></span><b>${running}</b> running</span>
    <span class="chip"><span class="dot working"></span>${workingA} working</span>
    <span class="chip"><span class="dot waiting"></span>${waiting} waiting</span>
    <span class="grow"></span>`;
  const stopAll = h(`<button class="btn sm">Stop all</button>`); stopAll.addEventListener('click', () => feats.forEach((f) => f.members.some((m) => m.running) && stopStack(f.name)));
  const restartAll = h(`<button class="btn sm">Restart all</button>`); restartAll.addEventListener('click', () => feats.forEach((f) => f.members.some((m) => m.running) && restartStack(f.name)));
  sum.appendChild(restartAll); sum.appendChild(stopAll);

  const list = $('#fleetTable');
  list.innerHTML = '';
  if (!feats.length && !agents.length) { list.appendChild(h(`<div class="fleet-empty">No worktrees or running agents. Start a session, or create a worktree by promoting one.</div>`)); return; }

  const section = (label, n) => h(`<div class="sectionrow">${esc(label)} · ${n}</div>`);
  if (serverFeats.length) { list.appendChild(section('⇅ Servers running', serverFeats.length)); serverFeats.forEach((f) => list.appendChild(serverRow(f))); }
  if (agents.length) { list.appendChild(section('✦ Agents · no worktree', agents.length)); agents.forEach((s) => list.appendChild(agentRow(s))); }
  if (feats.length) { list.appendChild(section('⎇ Worktrees', feats.length)); feats.forEach((f) => list.appendChild(featureRow(f))); }
}

// An unpromoted agent. Live → Promote is the next step; stopped → Restart resumes it.
function agentRow(s) {
  const stopped = s.state === 'stopped';
  const btn = (label, fn, cls = '') => { const b = h(`<button class="btn sm ${cls}">${label}</button>`); b.addEventListener('click', fn); return b; };
  const row = h(`<div class="frow${stopped ? ' stoppedrow' : ''}"></div>`);
  const l1 = h('<div class="frow-l1"></div>');
  l1.appendChild(h(`<span class="fname">${esc(s.title || 'session')}</span>`));
  l1.appendChild(h(`<span class="pill agent ${s.state}" title="Agent — the Claude session"><span class="dot ${s.state}"></span>agent · ${esc(s.state)}</span>`));
  l1.appendChild(h('<span class="pill srv nowt" title="Not promoted — no worktree yet"><span class="pi">✦</span>no worktree</span>'));
  l1.appendChild(h('<span class="grow"></span>'));
  if (stopped) {
    l1.appendChild(btn('↻ Resume', () => activateSession(s), 'go'));
    l1.appendChild(btn('Go to session ▸', () => goToSession(s.id)));
  } else {
    l1.appendChild(btn('Go to session ▸', () => goToSession(s.id), 'primary'));
    l1.appendChild(btn('⤴ Promote', () => promote(s), 'go'));
  }
  const del = h('<button class="btn sm ghost" title="Delete session" aria-label="Delete session">🗑</button>');
  del.addEventListener('click', () => closeSession(s));
  l1.appendChild(del);
  row.appendChild(l1);
  const l2 = h('<div class="frow-l2"></div>');
  const reps = (s.repos && s.repos.length ? s.repos : [{ repo: s.repoName }]);
  l2.innerHTML = reps.map((r) => `<span class="mchip"><span class="dot ${s.state}" title="${esc(s.state)}"></span><span class="r">${esc(r.repo)}</span> <span class="br">in main · no worktree</span></span>`).join('');
  row.appendChild(l2);
  return row;
}

// Compact readout of a feature whose dev servers are up (overlaps Worktrees on purpose).
function serverRow(f) {
  const btn = (label, fn, cls = '') => { const b = h(`<button class="btn sm ${cls}">${label}</button>`); b.addEventListener('click', fn); return b; };
  const ports = f.members.filter((m) => m && m.running).flatMap((m) => (m.ports || []).map((p) => `${m.repo}:${p}`));
  const row = h('<div class="frow srvrow"></div>');
  const l1 = h('<div class="frow-l1"></div>');
  l1.appendChild(h(`<span class="fname">${esc(f.name)}</span>`));
  l1.appendChild(h('<span class="pill srv done"><span class="pi">⇅</span>servers · running</span>'));
  l1.appendChild(h(`<span class="ports">${ports.map((p) => `<span class="p">${esc(p)}</span>`).join('')}</span>`));
  l1.appendChild(h('<span class="grow"></span>'));
  // one "Open <frontend> ↗" per running web repo — this is the section you watch when
  // servers are up, so the browse buttons belong here too (not just under Worktrees).
  webAppsFor(f.members.filter((m) => m && !m.missing)).forEach((web) => l1.appendChild(btn(`Open ${web.repo} ↗`, () => openApp(web.port), 'primary')));
  if (f.session) l1.appendChild(btn('Go to session ▸', () => goToSession(f.session.id)));
  l1.appendChild(btn('Stop stack', () => stopStack(f.name), 'danger'));
  row.appendChild(l1);
  return row;
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
  // concurrency slot (0,1,2…) — the offset that gives this feature its own ports/redis DB
  if (f.slot != null) l1.appendChild(h(`<span class="badge slot" title="Concurrency slot — its ports are offset by slot·100">slot ${esc(f.slot)}</span>`));
  l1.appendChild(h('<span class="grow"></span>'));
  if (pend) {
    l1.appendChild(h('<button class="btn sm" disabled>working…</button>'));
  } else {
    l1.appendChild(sess ? btn('Go to session ▸', () => goToSession(sess.id), 'primary') : btn('Start session', () => startFeatureSession(f), 'primary'));
    if (anyRunning) l1.appendChild(btn('Stop stack', () => stopStack(f.name), 'danger'));
    else if (anyStartable) l1.appendChild(btn('Run stack', () => runStack(f.name), 'go'));
    webAppsFor(ms).forEach((fweb) => l1.appendChild(btn(`Open ${fweb.repo} ↗`, () => openApp(fweb.port))));
    const more = h('<button class="btn sm ghost fmore" title="More" aria-label="More actions" aria-haspopup="menu">⋯</button>');
    more.addEventListener('click', (e) => { e.stopPropagation(); openFeatureMenu(more, f, { anyRunning, sess }); });
    l1.appendChild(more);
  }
  row.appendChild(l1);

  // line 2 — the stack detail
  const l2 = h('<div class="frow-l2"></div>');
  l2.innerHTML = ms.map((m) => { const dst = m.session ? m.session.state : (m.running ? 'done' : 'idle'); return `<span class="mchip"><span class="dot ${dst}" title="${esc(dst)}"></span><span class="r">${esc(m.repo)}</span> <span class="br">${esc(m.branch || m.wtname)}</span>${(m.ports || []).length ? ` <span class="p">${m.ports.map((p) => ':' + p).join(' ')}</span>` : ''}${m.merged ? ' <span class="badge merged">✓ merged</span>' : ''}</span>`; }).join('');
  row.appendChild(l2);
  return row;
}

function closeAnyMenu() { document.querySelectorAll('.fmenu').forEach((m) => m.remove()); }
function openFeatureMenu(anchor, f, { anyRunning, sess }) {
  const existing = document.querySelector('.fmenu');
  const wasThis = existing && existing._anchor === anchor;
  closeAnyMenu();
  if (wasThis) return; // clicking the same ⋯ again toggles it closed
  const menu = h('<div class="fmenu" role="menu" aria-label="Feature actions"></div>');
  menu._anchor = anchor;
  // Activating an item (click or Enter/Space) closes the menu and returns focus to
  // the ⋯ trigger before running the action, so keyboard focus is never orphaned.
  const item = (label, fn, cls = '') => {
    const d = h(`<div class="${cls}" role="menuitem" tabindex="0">${esc(label)}</div>`);
    const run = () => { closeAnyMenu(); if (anchor.focus) anchor.focus(); fn(); };
    d.addEventListener('click', run);
    d.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run(); } });
    menu.appendChild(d);
  };
  item('Open in editor', () => openGroup(f.name));
  if (anyRunning) item('Restart stack', () => restartStack(f.name));
  item('Open PR / MR', () => prFeature(f.name));
  menu.appendChild(h('<div class="sep"></div>'));
  if (anyRunning || sess) item('Close feature', () => closeFeature(f.name));
  item('Delete feature…', () => deleteFeature(f), 'danger');
  // roving focus: ↑/↓ move between items (wrapping); Escape closes + restores the trigger.
  menu.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Escape') return;
    e.preventDefault();
    if (e.key === 'Escape') { e.stopPropagation(); closeAnyMenu(); if (anchor.focus) anchor.focus(); return; }
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    const i = items.indexOf(document.activeElement);
    const d = e.key === 'ArrowDown' ? 1 : -1;
    items[(i + d + items.length) % items.length].focus();
  });
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${Math.max(8, rect.right - menu.offsetWidth)}px`;
  const first = menu.querySelector('[role="menuitem"]'); if (first) first.focus();
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
      // adopt returns HTTP 200 even when it can't (e.g. { error: 'already being
      // opened' }), so api() won't throw — guard on a real session like startFeatureSession.
      const s = await api('POST', '/api/worktrees/adopt', { repo: m.repo, worktreePath: m.path, branch: m.branch, wtname: m.wtname });
      if (s && s.id) { selectedId = s.id; toast(`Session started in ${m.repo}/${m.wtname} — open it in Work ▸`); }
      else toast((s && s.error) || 'Could not adopt worktree', true);
    } catch (e) { toast(e.message, true); }
  });
}

/* ---------------- settings / connections ---------------- */
async function openSettings() {
  settingsPrevFocus = document.activeElement;
  let data;
  try { data = await api('GET', '/api/settings'); } catch (e) { return toast(e.message, true); }
  const src = data.sources || {};
  const gl = src.gitlab || {}; const as = src.asana || {};
  const nt = data.notify || {};
  notifyPrefs = { ...notifyPrefs, ...nt }; // keep the live prefs in sync with disk
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
    </div>
    <div class="field">
      <label>Notifications <span class="hint">— when a session needs you</span></label>
      <label class="chk"><input type="checkbox" id="setNotifyWaiting" ${nt.waiting ? 'checked' : ''}/> Desktop notification when a session needs input</label>
      <label class="chk"><input type="checkbox" id="setNotifySound" ${nt.sound ? 'checked' : ''}/> Play a sound</label>
      <label class="chk"><input type="checkbox" id="setNotifyIdle" ${nt.idle ? 'checked' : ''}/> Notify when a turn completes</label>
    </div>
    <datalist id="setRepoList">${state.repos.map((r) => `<option value="${esc(r.name)}"></option>`).join('')}</datalist>
    <div class="setsec">
      <span class="lbl">Dev servers <span class="lbl-note">— per-repo launch command &amp; ports (space/comma separated)</span></span>
      <div id="setStartRows"></div>
      <button class="btn ghost xs" id="setStartAdd" style="align-self:flex-start">＋ add server</button>
    </div>
    <div class="setsec">
      <span class="lbl">Editors <span class="lbl-note">— <code>{path}</code> is the worktree path</span></span>
      <div id="setEditorRows"></div>
      <button class="btn ghost xs" id="setEditorAdd" style="align-self:flex-start">＋ add editor</button>
    </div>
    <div class="setsec">
      <span class="lbl">Feature groups <span class="lbl-note">— members are <code>repo/branch-or-wtname</code> refs, comma-separated</span></span>
      <div id="setGroupRows"></div>
      <button class="btn ghost xs" id="setGroupAdd" style="align-self:flex-start">＋ add group</button>
    </div>`;
  const wbox = $('#setNotifyWaiting');
  if (wbox) wbox.addEventListener('change', () => {
    if (wbox.checked && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  });
  // editable config rows (dev servers / editors / groups) — DOM built, add/remove per row
  const startRows = $('#setStartRows');
  Object.entries(data.start || {}).forEach(([repo, v]) => startRows.appendChild(settingsStartRow(repo, v)));
  $('#setStartAdd').addEventListener('click', () => startRows.appendChild(settingsStartRow('', {})));
  const edRows = $('#setEditorRows');
  Object.entries(data.editors || {}).forEach(([name, v]) => edRows.appendChild(settingsEditorRow(name, v)));
  $('#setEditorAdd').addEventListener('click', () => edRows.appendChild(settingsEditorRow('', {})));
  const grpRows = $('#setGroupRows');
  (data.groups || []).forEach((g) => grpRows.appendChild(settingsGroupRow(g)));
  $('#setGroupAdd').addEventListener('click', () => grpRows.appendChild(settingsGroupRow({})));
  $('#settingsModal').hidden = false;
  settingsTrap = trapFocus($('#settingsModal'));
  setTimeout(() => { const c = $('#setCancel'); if (c) c.focus(); }, 30);
}
function closeSettings() {
  if ($('#settingsModal').hidden) return;
  $('#settingsModal').hidden = true;
  if (settingsTrap) { settingsTrap(); settingsTrap = null; }
  if (settingsPrevFocus && settingsPrevFocus.focus) settingsPrevFocus.focus();
  settingsPrevFocus = null;
}

// One editable Dev-servers row: repo (datalist of scanned repos) · command · ports · remove.
function settingsStartRow(repo, v) {
  const ports = ((v && v.ports) || []).join(' ');
  const row = h(`<div class="srvcfg-row">
    <input class="dv-repo" list="setRepoList" value="${esc(repo)}" placeholder="repo…">
    <input class="dv-cmd" value="${esc((v && v.cmd) || '')}" placeholder="command…">
    <input class="dv-ports" value="${esc(ports)}" placeholder="ports">
    <button class="btn ghost xs" title="Remove" aria-label="Remove">✕</button>
  </div>`);
  row.querySelector('button').addEventListener('click', () => row.remove());
  return row;
}
// One editable Editor row: name · open command ({path}) · remove. openGroup is preserved via data attr.
function settingsEditorRow(name, v) {
  const og = v && v.openGroup ? ` data-opengroup="${esc(v.openGroup)}"` : '';
  const row = h(`<div class="srvcfg-row cols3"${og}>
    <input class="ed-name" value="${esc(name)}" placeholder="name…">
    <input class="ed-open" value="${esc((v && v.open) || '')}" placeholder="open command with {path}…">
    <button class="btn ghost xs" title="Remove" aria-label="Remove">✕</button>
  </div>`);
  row.querySelector('button').addEventListener('click', () => row.remove());
  return row;
}
// One editable Group row: name · members (comma-separated refs) · remove.
function settingsGroupRow(g) {
  const members = ((g && g.members) || []).join(', ');
  const row = h(`<div class="srvcfg-row cols3">
    <input class="gp-name" value="${esc((g && g.name) || '')}" placeholder="group name…">
    <input class="gp-members" value="${esc(members)}" placeholder="repo/branch, repo/branch…">
    <button class="btn ghost xs" title="Remove" aria-label="Remove">✕</button>
  </div>`);
  row.querySelector('button').addEventListener('click', () => row.remove());
  return row;
}

async function saveSettings() {
  const sources = {
    gitlab: { enabled: $('#setGlEnabled').checked, host: $('#setGlHost').value.trim(), project: $('#setGlProject').value.trim(), token: $('#setGlToken').value.trim() },
    asana: { enabled: $('#setAsEnabled').checked, token: $('#setAsToken').value.trim(), workspace: $('#setAsWorkspace').value.trim() },
  };
  const baseDirs = $('#setBaseDirs').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const notify = {
    waiting: !!($('#setNotifyWaiting') && $('#setNotifyWaiting').checked),
    sound: !!($('#setNotifySound') && $('#setNotifySound').checked),
    idle: !!($('#setNotifyIdle') && $('#setNotifyIdle').checked),
  };
  notifyPrefs = { ...notifyPrefs, ...notify };
  // gather the editable config rows, skipping blanks and coercing ports to positive ints
  const start = {};
  document.querySelectorAll('#setStartRows .srvcfg-row').forEach((row) => {
    const repo = row.querySelector('.dv-repo').value.trim();
    const cmd = row.querySelector('.dv-cmd').value.trim();
    if (!repo || !cmd) return;
    const ports = row.querySelector('.dv-ports').value.split(/[\s,]+/).map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n > 0);
    start[repo] = { cmd, ports };
  });
  const editors = {};
  document.querySelectorAll('#setEditorRows .srvcfg-row').forEach((row) => {
    const name = row.querySelector('.ed-name').value.trim();
    const open = row.querySelector('.ed-open').value.trim();
    if (!name || !open) return;
    const og = row.dataset.opengroup;
    editors[name] = og ? { open, openGroup: og } : { open };
  });
  const groups = [];
  document.querySelectorAll('#setGroupRows .srvcfg-row').forEach((row) => {
    const name = row.querySelector('.gp-name').value.trim();
    const members = row.querySelector('.gp-members').value.split(',').map((s) => s.trim()).filter(Boolean);
    if (!name || !members.length) return;
    groups.push({ name, members });
  });
  try { await api('POST', '/api/settings', { sources, baseDirs, notify, start, editors, groups }); closeSettings(); toast('Settings saved'); } catch (e) { toast(e.message, true); }
}

/* ---------------- command palette (⌘K) ---------------- */
// Built dynamically like uiDialog: a backdrop + input + scrollable list. Its own
// keydown handler (arrows/Enter) is attached on open and removed on close so no
// listener leaks. ⌘K toggle and Escape close are handled by the global handler.
let palette = null; // { back, input, list, rows:[{el,run}], hi } while open, else null

function paletteOpen() { return !!palette; }

function togglePalette() { if (palette) closePalette(); else openPalette(); }

function openPalette() {
  if (palette) return;
  const prevFocus = document.activeElement;
  const back = h('<div class="modal-backdrop top palette-back"></div>');
  const box = h('<div class="palette" role="dialog" aria-modal="true" aria-label="Command palette"></div>');
  const input = h('<input type="text" spellcheck="false" autocomplete="off" placeholder="Jump to a session or run a command…" />');
  const list = h('<div class="palette-list"></div>');
  box.appendChild(input); box.appendChild(list); back.appendChild(box);
  document.body.appendChild(back);
  palette = { back, input, list, rows: [], hi: 0, prevFocus, untrap: trapFocus(back) };
  input.addEventListener('input', renderPalette);
  back.addEventListener('click', (e) => { if (e.target === back) closePalette(); });
  palette.onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); runPaletteHighlighted(); }
  };
  document.addEventListener('keydown', palette.onKey);
  renderPalette();
  setTimeout(() => input.focus(), 20);
}

function closePalette() {
  if (!palette) return;
  document.removeEventListener('keydown', palette.onKey);
  if (palette.untrap) palette.untrap();
  const prev = palette.prevFocus;
  palette.back.remove();
  palette = null;
  if (prev && prev.focus) prev.focus();
}

// Build the filtered Sessions + Commands rows for the current query and context.
function paletteRows() {
  const q = palette.input.value.trim().toLowerCase();
  const railIdx = new Map();
  railOrderedSessions().forEach((s, i) => railIdx.set(s.id, i));

  const sessRows = [];
  for (const s of state.sessions) {
    if (q && !`${s.title} ${s.repoName} ${s.state}`.toLowerCase().includes(q)) continue;
    const i = railIdx.get(s.id);
    const hint = (i != null && i < 9) ? ` · ⌘${i + 1}` : '';
    sessRows.push({
      html: `<span class="pg">${s.worktreePath ? '⎇' : '✦'}</span><span class="dot ${s.state}"></span><span class="ptitle">${esc(s.title)}</span><span class="psub">${esc(s.repoName)} · ${esc(s.state)}${hint}</span>`,
      run: () => { closePalette(); selectSession(s.id); setView('work'); },
    });
  }

  const cur = state.sessions.find((x) => x.id === selectedId);
  const cmds = [];
  const add = (glyph, label, sub, run) => cmds.push({ glyph, label, sub, run });
  add('＋', 'New session', '⌘N', () => openModal());
  if (cur && !cur.worktreePath) add('⤴', 'Promote current to worktree', '⌘↵', () => promote(cur));
  if (cur && cur.worktreePath) add('✎', 'Review changes', '⌘D', () => { selectSession(cur.id); setView('work'); openChanges(cur); });
  if (cur && cur.worktreePath) add('▶', 'Run stack', '⌘R', () => startSessionServers(cur));
  add('◧', 'Toggle Work / Fleet', '⌘\\', () => setView(view === 'work' ? 'fleet' : 'work'));
  if (cur) {
    if (cur.active === false) add('↻', 'Resume current', '', () => activateSession(cur));
    else add('⏻', 'Deactivate current', '', () => deactivateSession(cur));
  }
  add('⚙', 'Open Settings', '', () => openSettings());
  add('?', 'Keyboard shortcuts', '?', () => showShortcuts());

  const cmdRows = [];
  for (const c of cmds) {
    if (q && !c.label.toLowerCase().includes(q)) continue;
    cmdRows.push({
      html: `<span class="pg">${c.glyph}</span><span class="ptitle">${esc(c.label)}</span>${c.sub ? `<span class="psub">${esc(c.sub)}</span>` : ''}`,
      run: () => { closePalette(); c.run(); },
    });
  }
  return { sessRows, cmdRows };
}

function renderPalette() {
  if (!palette) return;
  const { sessRows, cmdRows } = paletteRows();
  palette.list.innerHTML = '';
  palette.rows = [];
  const section = (label, rows) => {
    if (!rows.length) return;
    palette.list.appendChild(h(`<div class="psec">${esc(label)}</div>`));
    for (const r of rows) {
      const el = h(`<div class="pcmd">${r.html}</div>`);
      const idx = palette.rows.length;
      el.addEventListener('click', r.run);
      el.addEventListener('mousemove', () => { if (palette.hi !== idx) { palette.hi = idx; paintPalette(); } });
      palette.rows.push({ el, run: r.run });
      palette.list.appendChild(el);
    }
  };
  section('Sessions', sessRows);
  section('Commands', cmdRows);
  if (!palette.rows.length) palette.list.appendChild(h(`<div class="psec">No matches</div>`));
  palette.hi = 0;
  paintPalette();
}

function paintPalette() {
  palette.rows.forEach((r, i) => r.el.classList.toggle('on', i === palette.hi));
  const cur = palette.rows[palette.hi];
  if (cur) cur.el.scrollIntoView({ block: 'nearest' });
}

function movePalette(d) {
  const n = palette.rows.length;
  if (!n) return;
  palette.hi = (palette.hi + d + n) % n;
  paintPalette();
}

function runPaletteHighlighted() {
  const cur = palette.rows[palette.hi];
  if (cur) cur.run();
}

/* ---------------- global keyboard shortcuts ---------------- */
function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
// A blocking overlay = the palette, the intake/settings modals, or a live uiDialog.
function overlayOpen() {
  return paletteOpen() || !$('#modal').hidden || !$('#settingsModal').hidden || !!document.querySelector('.modal-backdrop .modal.dlg');
}

// Lightweight, always-available cheatsheet of the global shortcuts (opened by ? or
// from the palette). Rendered through uiDialog so it inherits the focus trap/restore.
function showShortcuts() {
  const rows = [
    ['⌘K', 'Command palette'],
    ['⌘N', 'New session'],
    ['⌘\\', 'Toggle Work / Fleet'],
    ['⌘1–9', 'Jump to the Nth session'],
    ['⌘↵', 'Promote current to worktree'],
    ['⌘D', 'Review changes'],
    ['⌘R', 'Run dev servers'],
    ['?', 'This help'],
  ];
  const html = `<div class="kbd-list">${rows.map(([k, d]) => `<div class="kbd-row"><kbd>${esc(k)}</kbd><span>${esc(d)}</span></div>`).join('')}</div>`;
  uiDialog({ title: 'Keyboard shortcuts', messageHtml: html, okLabel: 'Done', cancelLabel: '' });
}

function handleShortcut(e) {
  const meta = e.metaKey || e.ctrlKey;
  // ⌘K always toggles the palette — even from inside an input.
  if (meta && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); togglePalette(); return; }
  // Escape closes the topmost overlay (palette first, then settings, else intake).
  // uiDialogs handle their own Escape via their own keydown listener.
  if (e.key === 'Escape') {
    if (paletteOpen()) closePalette();
    else if (!$('#settingsModal').hidden) closeSettings();
    else closeModal();
    return;
  }
  // ? (Shift+/) opens the shortcuts cheatsheet — but never while typing or over an overlay.
  if (e.key === '?' && !isTypingTarget(e.target) && !overlayOpen()) { e.preventDefault(); showShortcuts(); return; }
  // Beyond ⌘K/Escape, never hijack typing or act while an overlay is up.
  if (isTypingTarget(e.target) || overlayOpen() || !meta) return;

  const s = state.sessions.find((x) => x.id === selectedId);
  if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openModal(); return; }
  if (e.key === '\\') { e.preventDefault(); setView(view === 'work' ? 'fleet' : 'work'); return; }
  if (e.key >= '1' && e.key <= '9') {
    const rail = railOrderedSessions();
    const pick = rail[+e.key - 1];
    if (pick) { e.preventDefault(); selectSession(pick.id); setView('work'); }
    return;
  }
  if (e.key === 'Enter') { if (s && !s.worktreePath) { e.preventDefault(); promote(s); } return; }
  if (e.key === 'd' || e.key === 'D') { if (s && s.worktreePath) { e.preventDefault(); selectSession(s.id); setView('work'); openChanges(s); } return; }
  if (e.key === 'r' || e.key === 'R') { if (s && s.worktreePath) { e.preventDefault(); startSessionServers(s); } return; }
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
  $('#mStart').addEventListener('click', () => guardBtn($('#mStart'), startSession, 'Starting…'));
  $('#repoFilter').addEventListener('change', (e) => { repoFilter = e.target.value; render(); });
  document.querySelectorAll('#viewSeg button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settingsClose').addEventListener('click', closeSettings);
  $('#setCancel').addEventListener('click', closeSettings);
  $('#setSave').addEventListener('click', saveSettings);
  $('#settingsModal').addEventListener('click', (e) => { if (e.target.id === 'settingsModal') closeSettings(); });
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  if ($('#paletteBtn')) $('#paletteBtn').addEventListener('click', togglePalette);
  document.addEventListener('keydown', handleShortcut);
  loadNotifyPrefs();
  connectSSE();
}
document.addEventListener('DOMContentLoaded', init);
