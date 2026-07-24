'use strict';
// The session manager: the origin is a real Claude Code process running inside
// a multiplexer session. Create (seeded on CLAUDE.md, in the main repo) →
// promote to a worktree (same session continues) → pop-out / tabs / restore.
const { EventEmitter } = require('events');
const path = require('path');
const { readJson, writeJson, makeId, slug, shq } = require('./util');
const status = require('./status');
const worktree = require('./worktree');

function deriveBranch(seed) {
  const s = slug(seed.title);
  const type = /\b(fix|bug|error|broken|regression|crash|fails?)\b/i.test(`${seed.title} ${seed.body}`) ? 'fix' : 'feature';
  const num = seed.id && /^\d+$/.test(String(seed.id)) ? `${seed.id}-` : '';
  return `${type}/${num}${s}`;
}

function seedPrompt(seed) {
  // Send the user's prompt as-is. Free text: exactly what they typed (no wrapper,
  // no duplication). Issue sources: the issue title + body + link (that IS the ask).
  if (seed.source === 'freetext') return (seed.body || seed.title || '').trim();
  const parts = [seed.title];
  if (seed.body && seed.body.trim()) parts.push('', seed.body.trim());
  if (seed.url) parts.push('', seed.url);
  return parts.join('\n').trim();
}

class SessionManager extends EventEmitter {
  constructor(cfg, mux) {
    super();
    this.cfg = cfg;
    this.mux = mux;
    this.file = path.join(cfg._stateDir, 'sessions.json');
    this.sessions = new Map();
    this._adopting = new Set(); // worktreePaths with an adopt in flight (dedup guard)
    for (const s of readJson(this.file, []) || []) this.sessions.set(s.id, s);
  }

  all() { return [...this.sessions.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); }
  get(id) { return this.sessions.get(id); }
  _save() { writeJson(this.file, this.all()); }
  _touch(id) { this._save(); this.emit('change', { type: 'session', id }); }

  // The session (if any) whose promoted/adopted worktree is this path — used to
  // surface agent state on a Fleet worktree row.
  sessionForWorktree(worktreePath) {
    if (!worktreePath) return null;
    const norm = (p) => { try { return require('fs').realpathSync(p); } catch { return p; } };
    const target = norm(worktreePath);
    for (const s of this.sessions.values()) {
      if (s.worktreePath && norm(s.worktreePath) === target) return s;
      if ((s.repos || []).some((r) => r.worktreePath && norm(r.worktreePath) === target)) return s;
    }
    return null;
  }

  claudeCmd(session, { resume } = {}) {
    // Launch claude clean; the seeded first message is typed in once the session
    // is ready (see injectPrompt) — passing a multi-line prompt as a launch arg
    // was unreliable through the multiplexer layout.
    // NB: the installed claude rejects -n/--name, so we don't set a display name here.
    // Scrub claude env markers inherited from the parent process so each session
    // is a clean, top-level claude (transcripts on, no "child session" behavior).
    // Drop only the child-session marker (keeps transcripts + normal behavior) and
    // force persistence. Everything else stays so the launcher can still find the
    // (inherited) claude binary — unsetting CLAUDECODE/EXECPATH breaks that.
    const CLEAN = 'env -u CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1';
    const parts = [CLEAN, this.cfg.claude.cmd || 'claude', '--settings', shq(session.settingsFile)];
    if (resume && session.claudeSessionId) parts.push('-r', shq(session.claudeSessionId));
    // grant tool access to any sibling-repo worktrees this session already owns
    for (const r of session.repos || []) {
      if (!r.primary && r.worktreePath) parts.push('--add-dir', shq(r.worktreePath));
    }
    // tell claude it can pull in another repo itself (single line — no newlines,
    // which would break the multiplexer layout)
    const cli = require('path').join(__dirname, '..', 'bin', 'wt-studio.js');
    const note = `You're in a Worktree Studio session (feature "${session.feature}"). If this work needs changes in another repo, run: ${cli} add-repo <repo-name> — it creates a same-named worktree in that repo and grants you access. Repos live under ${(this.cfg.baseDirs || []).join(', ')}.`;
    parts.push('--append-system-prompt', shq(note));
    return parts.join(' ');
  }

  // Add a repo to this session's feature: create a same-named worktree there and
  // grant the live session access via /add-dir. Used by the UI button and the CLI
  // (so both David and claude can trigger it).
  async addRepo(id, { repo, repoPath }) {
    const s = this.get(id);
    if (!s) return { ok: false, error: 'no such session' };
    if ((s.repos || []).some((r) => r.repo === repo)) return { ok: true, already: true, session: s };
    const branch = s.branch || `feature/${s.feature}`;
    const res = await worktree.create(repoPath, branch, s.feature, {
      copyPatterns: (this.cfg.copyPatterns && (this.cfg.copyPatterns[repo] || this.cfg.copyPatterns.default)) || [],
    });
    if (!res.ok) {
      // the repo already has this feature's worktree → attach it instead of failing
      if (/already exists/i.test(res.error || '') && res.path) {
        const a = await this.attachRepo(id, { repo, repoPath, worktreePath: res.path, branch: res.branch, wtname: res.name });
        return a.ok ? { ok: true, session: s, worktree: { name: res.name, path: res.path, branch: res.branch }, attached: true } : a;
      }
      return res;
    }
    s.repos.push({ repo, repoPath, worktree: res.name, worktreePath: res.path, branch: res.branch, primary: false });
    // grant the running session access, live
    await this.mux.sendText(s.muxName, `/add-dir ${res.path}`);
    this._touch(id);
    return { ok: true, session: s, worktree: res };
  }

  // Attach an EXISTING worktree to a session (no creation) and grant /add-dir.
  // Used when starting one session for a feature whose worktrees already exist.
  async attachRepo(id, { repo, repoPath, worktreePath, branch, wtname }) {
    const s = this.get(id);
    if (!s) return { ok: false };
    if ((s.repos || []).some((r) => r.worktreePath === worktreePath)) return { ok: true, already: true };
    s.repos.push({ repo, repoPath, worktree: wtname, worktreePath, branch, primary: false });
    await this.mux.sendText(s.muxName, `/add-dir ${worktreePath}`);
    this._touch(id);
    return { ok: true };
  }

  // Type the seeded first message into a freshly-started session and submit it.
  // Collapsed to one line so a single Enter submits (newlines would submit early).
  async injectPrompt(id) {
    const s = this.get(id);
    if (!s || !s.pendingPrompt) return;
    const line = s.pendingPrompt.replace(/\s*\n\s*/g, ' ').trim();
    s.pendingPrompt = null;
    await this.mux.sendText(s.muxName, line);
  }

  async create({ seed, repoPath, repoName, additionalRepos }) {
    const id = makeId('s_');
    const title = seed.title || 'New session';
    const name = slug(title);
    const muxName = `wts-${name}-${id.slice(2)}`.slice(0, 60);
    const session = {
      id,
      title,
      source: seed.source,
      sourceId: seed.id || null,
      sourceUrl: seed.url || null,
      repoName,
      repoPath,
      home: repoPath, // where the session's identity lives (its transcript)
      worktree: null,
      worktreePath: null,
      branch: null,
      feature: name, // the identity that ties this feature's worktrees together across repos
      // repos this session spans; the primary is where claude launches. Additional
      // repos are reached via --add-dir / /add-dir. Worktrees are null until promote.
      repos: [{ repo: repoName, repoPath, worktree: null, worktreePath: null, branch: null, primary: true }],
      pendingRepos: additionalRepos || [], // { repo, repoPath } to add at promote (up-front)
      suggestedBranch: deriveBranch(seed),
      suggestedName: name,
      muxName,
      claudeSessionId: null,
      state: 'idle',
      activity: 'starting…',
      tabs: [{ title: 'claude' }],
      pendingPrompt: seedPrompt(seed),
      active: true,
      createdAt: Date.now(),
      promotedAt: null,
    };
    session.settingsFile = status.settingsFile(this.cfg._stateDir, id, this.cfg.web.port);
    this.sessions.set(id, session);

    const cmd = this.claudeCmd(session);
    const r = await this.mux.ensure(muxName, { cwd: repoPath, cmd, env: { WT_STUDIO_SESSION: id } });
    if (r.error) { session.state = 'stopped'; session.activity = `failed to start: ${r.error}`; }
    // Inject the first message once claude is up. The SessionStart hook triggers
    // it (applyHook); this is a fallback in case the hook is slow/absent.
    else setTimeout(() => this.injectPrompt(id).catch(() => {}), 12000);
    this._touch(id);
    return session;
  }

  // Start a session in a worktree that already exists (no promote step).
  async adopt({ worktreePath, repoName, repoPath, branch, wtname, seed }) {
    // dedup: never open two sessions for the same worktree, even on concurrent calls
    const existing = this.sessionForWorktree(worktreePath);
    if (existing) return existing;
    if (this._adopting.has(worktreePath)) return null;
    this._adopting.add(worktreePath);
    try {
      return await this._doAdopt({ worktreePath, repoName, repoPath, branch, wtname, seed });
    } finally { this._adopting.delete(worktreePath); }
  }

  async _doAdopt({ worktreePath, repoName, repoPath, branch, wtname, seed }) {
    const s = seed || { source: 'freetext', title: wtname || require('path').basename(worktreePath), body: '', url: null };
    const id = makeId('s_');
    const title = s.title;
    const muxName = `wts-${slug(wtname || title)}-${id.slice(2)}`.slice(0, 60);
    const session = {
      id, title, source: s.source, sourceId: s.id || null, sourceUrl: s.url || null,
      repoName, repoPath, home: repoPath,
      worktree: wtname, worktreePath, branch: branch || null,
      feature: slug(wtname || title),
      repos: [{ repo: repoName, repoPath, worktree: wtname, worktreePath, branch: branch || null, primary: true }],
      pendingRepos: [],
      suggestedBranch: branch || null, suggestedName: wtname || slug(title),
      muxName, claudeSessionId: null, state: 'idle', activity: 'starting…',
      tabs: [{ title: 'claude' }], pendingPrompt: seed ? seedPrompt(seed) : null, active: true,
      createdAt: Date.now(), promotedAt: Date.now(), adopted: true,
    };
    session.settingsFile = status.settingsFile(this.cfg._stateDir, id, this.cfg.web.port);
    this.sessions.set(id, session);
    const cmd = this.claudeCmd(session);
    const r = await this.mux.ensure(muxName, { cwd: worktreePath, cmd, env: { WT_STUDIO_SESSION: id } });
    if (r.error) { session.state = 'stopped'; session.activity = `failed to start: ${r.error}`; }
    else if (session.pendingPrompt) setTimeout(() => this.injectPrompt(id).catch(() => {}), 12000);
    this._touch(id);
    return session;
  }

  async promote(id, { branch, name } = {}) {
    const s = this.get(id);
    if (!s) return { ok: false, error: 'no such session' };
    if (s.worktreePath) return { ok: false, error: 'already promoted' };
    const br = branch || s.suggestedBranch;
    const wtName = name || s.suggestedName;
    const res = await worktree.create(s.repoPath, br, wtName, {
      unique: true, // auto-suffix on collision rather than fail
      copyPatterns: (this.cfg.copyPatterns && (this.cfg.copyPatterns[s.repoName] || this.cfg.copyPatterns.default)) || [],
    });
    if (!res.ok) return res;
    s.worktree = res.name;
    s.worktreePath = res.path;
    s.branch = res.branch;
    s.feature = res.name; // the worktree name is the feature identity across repos
    s.promotedAt = Date.now();
    // record the primary repo's worktree
    const primary = (s.repos || []).find((r) => r.primary);
    if (primary) { primary.worktree = res.name; primary.worktreePath = res.path; primary.branch = res.branch; }
    // rename the mux session to the worktree (best-effort; harmless if unsupported)
    const newMux = `wts-${res.name}`.slice(0, 60);
    if (await this.mux.rename(s.muxName, newMux)) s.muxName = newMux;
    // tell the running session to continue inside the worktree
    await this.mux.sendText(s.muxName, `The worktree is ready at ${res.path} — please cd there and do all further work in that directory.`);
    this._touch(id);
    // fan out to any repos chosen up front (creates their worktrees + grants access)
    for (const pr of s.pendingRepos || []) {
      try { await this.addRepo(id, pr); } catch { /* */ }
    }
    s.pendingRepos = [];
    return { ok: true, session: s, worktree: res };
  }

  async addTab(id, { title, cmd } = {}) {
    const s = this.get(id);
    if (!s) return { ok: false, error: 'no such session' };
    const cwd = s.worktreePath || s.repoPath;
    const r = await this.mux.newTab(s.muxName, { title: title || 'shell', cwd, cmd });
    if (r.ok) { s.tabs.push({ title: title || 'shell' }); this._touch(id); }
    return r;
  }

  async selectTab(id, index) {
    const s = this.get(id);
    if (!s) return { ok: false };
    const ok = await this.mux.selectTab(s.muxName, index);
    return { ok };
  }

  async closeTab(id, index) {
    const s = this.get(id);
    if (!s) return { ok: false };
    if ((s.tabs || []).length <= 1) return { ok: false, error: 'can’t close the only tab' };
    await this.mux.closeTab(s.muxName, index);
    (s.tabs || []).splice(index, 1);
    this._touch(id);
    return { ok: true };
  }

  popout(id) {
    const s = this.get(id);
    if (!s) return null;
    return this.mux.popoutCommand(s.muxName);
  }

  async close(id, { kill = true } = {}) {
    const s = this.get(id);
    if (!s) return { ok: false };
    if (kill) await this.mux.kill(s.muxName);
    this.sessions.delete(id);
    this._save();
    this.emit('change', { type: 'session-removed', id });
    return { ok: true };
  }

  // Apply a Claude Code hook event to a session's live state.
  applyHook(id, event, payload) {
    const s = this.get(id);
    if (!s) return;
    if (event === 'SessionStart') {
      if (payload && payload.session_id) s.claudeSessionId = payload.session_id;
      // claude is up — type in the seeded first message. Wait for the TUI input to
      // be ready (it isn't immediately at SessionStart), else the keystrokes drop.
      if (s.pendingPrompt) setTimeout(() => this.injectPrompt(id).catch(() => {}), 4000);
    }
    const m = status.mapEvent(event, payload);
    if (m) { s.state = m.state; if (m.activity) s.activity = m.activity; }
    // the agent's own process exited — mark inactive so the UI offers Reactivate
    if (event === 'SessionEnd') s.active = false;
    s.lastEventAt = Date.now();
    this._touch(id);
  }

  async rename(id, title) {
    const s = this.get(id);
    if (!s || !title || !title.trim()) return { ok: false, error: 'invalid title' };
    s.title = title.trim();
    this._touch(id);
    return { ok: true };
  }

  // Stop the running process but keep the session (resumable later).
  async deactivate(id) {
    const s = this.get(id);
    if (!s) return { ok: false };
    await this.mux.kill(s.muxName);
    s.active = false;
    s.state = 'stopped';
    s.activity = 'deactivated';
    this._touch(id);
    return { ok: true };
  }

  // Bring a deactivated session back, resuming its conversation.
  async activate(id) {
    const s = this.get(id);
    if (!s) return { ok: false };
    const cmd = this.claudeCmd(s, { resume: !!s.claudeSessionId });
    const cwd = s.worktreePath || s.home || s.repoPath;
    const r = await this.mux.ensure(s.muxName, { cwd, cmd, env: { WT_STUDIO_SESSION: s.id } });
    s.active = true;
    s.state = 'idle';
    s.activity = s.claudeSessionId ? 'resumed' : 'restarted';
    this._touch(id);
    return { ok: !r.error, error: r.error };
  }

  // Reconcile a session's tab strip with the tmux windows that actually exist.
  async _syncTabs(s) {
    try {
      const live = await this.mux.listTabs(s.muxName);
      if (!live.length) return;
      const prev = s.tabs || [];
      // keep our stored titles by position; fall back to the live window name
      s.tabs = live.map((w, i) => ({ title: (prev[i] && prev[i].title) || w.title }));
    } catch { /* leave tabs as-is if the mux can't be queried */ }
  }

  // Recreate every persisted session after a restart, resuming the conversation.
  async restore() {
    let n = 0;
    for (const s of this.all()) {
      if (!s.muxName) continue;
      if (await this.mux.hasSession(s.muxName)) { s.activity = 'reattached'; await this._syncTabs(s); continue; }
      const cmd = this.claudeCmd(s, { resume: !!s.claudeSessionId });
      const cwd = s.worktreePath || s.home || s.repoPath;
      await this.mux.ensure(s.muxName, { cwd, cmd, env: { WT_STUDIO_SESSION: s.id } });
      // restore recreates only the primary claude window — drop any stale extra
      // tabs so the tab strip matches the windows that actually exist.
      s.tabs = [{ title: 'claude' }];
      s.state = 'idle';
      s.activity = s.claudeSessionId ? 'resumed' : 'restarted';
      n++;
    }
    this._save();
    this.emit('change', { type: 'restore', count: n });
    return n;
  }
}

module.exports = { SessionManager, deriveBranch, seedPrompt };
