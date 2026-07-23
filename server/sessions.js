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
  const lines = [`We're working on: ${seed.title}`];
  if (seed.body && seed.body.trim()) lines.push('', seed.body.trim());
  if (seed.url) lines.push('', `Reference: ${seed.url}`);
  lines.push('', "Let's plan this. When it's ready to build, I'll promote it to a worktree.");
  return lines.join('\n');
}

class SessionManager extends EventEmitter {
  constructor(cfg, mux) {
    super();
    this.cfg = cfg;
    this.mux = mux;
    this.file = path.join(cfg._stateDir, 'sessions.json');
    this.sessions = new Map();
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
    for (const s of this.sessions.values()) if (s.worktreePath === worktreePath) return s;
    return null;
  }

  claudeCmd(session, { resume } = {}) {
    const parts = [this.cfg.claude.cmd || 'claude', '--settings', shq(session.settingsFile), '-n', shq(session.title)];
    if (resume && session.claudeSessionId) {
      parts.push('-r', shq(session.claudeSessionId));
    } else if (session.seedPrompt) {
      parts.push(shq(session.seedPrompt));
    }
    return parts.join(' ');
  }

  async create({ seed, repoPath, repoName }) {
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
      suggestedBranch: deriveBranch(seed),
      suggestedName: name,
      muxName,
      claudeSessionId: null,
      state: 'idle',
      activity: 'starting…',
      tabs: [{ title: 'claude' }],
      seedPrompt: seedPrompt(seed),
      createdAt: Date.now(),
      promotedAt: null,
    };
    session.settingsFile = status.settingsFile(this.cfg._stateDir, id, this.cfg.web.port);
    this.sessions.set(id, session);

    const cmd = this.claudeCmd(session);
    const r = await this.mux.ensure(muxName, { cwd: repoPath, cmd, env: { WT_STUDIO_SESSION: id } });
    if (r.error) { session.state = 'stopped'; session.activity = `failed to start: ${r.error}`; }
    this._touch(id);
    return session;
  }

  // Start a session in a worktree that already exists (no promote step).
  async adopt({ worktreePath, repoName, repoPath, branch, wtname, seed }) {
    const existing = this.sessionForWorktree(worktreePath);
    if (existing) return existing;
    const s = seed || { source: 'freetext', title: wtname || require('path').basename(worktreePath), body: '', url: null };
    const id = makeId('s_');
    const title = s.title;
    const muxName = `wts-${slug(wtname || title)}-${id.slice(2)}`.slice(0, 60);
    const session = {
      id, title, source: s.source, sourceId: s.id || null, sourceUrl: s.url || null,
      repoName, repoPath, home: repoPath,
      worktree: wtname, worktreePath, branch: branch || null,
      suggestedBranch: branch || null, suggestedName: wtname || slug(title),
      muxName, claudeSessionId: null, state: 'idle', activity: 'starting…',
      tabs: [{ title: 'claude' }], seedPrompt: seed ? seedPrompt(seed) : null,
      createdAt: Date.now(), promotedAt: Date.now(), adopted: true,
    };
    session.settingsFile = status.settingsFile(this.cfg._stateDir, id, this.cfg.web.port);
    this.sessions.set(id, session);
    const cmd = this.claudeCmd(session);
    const r = await this.mux.ensure(muxName, { cwd: worktreePath, cmd, env: { WT_STUDIO_SESSION: id } });
    if (r.error) { session.state = 'stopped'; session.activity = `failed to start: ${r.error}`; }
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
      copyPatterns: (this.cfg.copyPatterns && (this.cfg.copyPatterns[s.repoName] || this.cfg.copyPatterns.default)) || [],
    });
    if (!res.ok) return res;
    s.worktree = res.name;
    s.worktreePath = res.path;
    s.branch = res.branch;
    s.promotedAt = Date.now();
    // rename the mux session to the worktree (best-effort; harmless if unsupported)
    const newMux = `wts-${res.name}`.slice(0, 60);
    if (await this.mux.rename(s.muxName, newMux)) s.muxName = newMux;
    // tell the running session to continue inside the worktree
    await this.mux.sendText(s.muxName, `The worktree is ready at ${res.path} — please cd there and do all further work in that directory.`);
    this._touch(id);
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
    if (event === 'SessionStart' && payload && payload.session_id) s.claudeSessionId = payload.session_id;
    const m = status.mapEvent(event, payload);
    if (m) { s.state = m.state; if (m.activity) s.activity = m.activity; }
    s.lastEventAt = Date.now();
    this._touch(id);
  }

  // Recreate every persisted session after a restart, resuming the conversation.
  async restore() {
    let n = 0;
    for (const s of this.all()) {
      if (!s.muxName) continue;
      if (await this.mux.hasSession(s.muxName)) { s.activity = 'reattached'; continue; }
      const cmd = this.claudeCmd(s, { resume: !!s.claudeSessionId });
      const cwd = s.worktreePath || s.home || s.repoPath;
      await this.mux.ensure(s.muxName, { cwd, cmd, env: { WT_STUDIO_SESSION: s.id } });
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
