'use strict';
// The session manager: the origin is a real Claude Code process running inside
// a multiplexer session. Create (seeded on CLAUDE.md, in the main repo) →
// promote to a worktree (same session continues) → pop-out / tabs / restore.
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { readJsonState, writeJson, makeId, shortId, realpath, slug, shq, run } = require('./util');
const status = require('./status');
const worktree = require('./worktree');
const layoutMod = require('./layout');
const { createIdentity } = require('./identity');
const { worktreeCopyOpts } = worktree;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Collapse a (possibly multi-line) seed to a single line so it can ride along as
// one launch arg / one submitted message.
function collapse(text) { return (text || '').replace(/\s*\n\s*/g, ' ').trim(); }

// Is `cmd` a bare login/interactive shell (i.e. claude is NOT the foreground
// program in the pane)? tmux's pane_current_command may be prefixed with '-'.
function isShell(cmd) {
  const c = String(cmd || '').replace(/^-/, '');
  return /^(?:bash|zsh|sh|fish|dash|ksh|csh|tcsh|login)$/i.test(c);
}

// tmux session name for a session: `wts-<feature>-<id tail>`, capped at 60 chars.
// The cap is taken out of the FEATURE, never out of the tail — two sessions of the
// same feature are told apart only by that suffix, and truncating the whole string
// (which is what this did while ids were tiny) silently eats it now that ids are
// UUIDs. muxName is persisted per session, so existing sessions keep their name.
const MUX_MAX = 60;
function muxNameFor(name, id) {
  const tail = shortId(id);
  const room = MUX_MAX - 'wts-'.length - 1 - tail.length;
  return `wts-${String(name || 'session').slice(0, Math.max(1, room))}-${tail}`;
}

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
  // `identity` is the shared server/identity.js resolver (server.js builds one and
  // hands the same instance to state.js/servers.js). A session stores the feature
  // IDENTITY it belongs to, and that has to be the same answer features.js groups
  // by — otherwise `POST /group/pr { group: session.feature }` looks up a feature
  // that doesn't exist under any strategy but `basename`.
  constructor(cfg, mux, identity) {
    super();
    this.cfg = cfg;
    this.mux = mux;
    this.identity = identity || createIdentity(cfg);
    this.layout = layoutMod.resolve(cfg); // where the worktrees this manager creates live
    this.file = path.join(cfg._stateDir, 'sessions.json');
    this.sessions = new Map();
    this._adopting = new Set(); // worktreePaths with an adopt in flight (dedup guard)
    // readJsonState, not readJson: a corrupt sessions.json must be preserved rather
    // than silently replaced by an empty one on the next save — it holds the
    // claudeSessionId values that tie each session to a live claude conversation.
    for (const s of readJsonState(this.file, []) || []) this.sessions.set(s.id, s);
  }

  all() { return [...this.sessions.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); }
  get(id) { return this.sessions.get(id); }
  _save() { writeJson(this.file, this.all()); }
  _touch(id) { this._save(); this.emit('change', { type: 'session', id }); }

  // (Re)write a session's Claude Code hook settings file and record that its URLs now
  // carry the boot token. The flag is what lets the /hook receiver keep accepting
  // tokenless reports from sessions whose claude was launched by an older build —
  // that process already read its settings file and will never re-read it. The
  // exemption clears itself the moment the session is relaunched through here.
  _writeHookSettings(s) {
    s.settingsFile = status.settingsFile(this.cfg._stateDir, s.id, this.cfg.web.port, this.cfg._token);
    s.hookAuth = !!this.cfg._token;
  }

  // Every worktree path any session owns → that session, keyed by RESOLVED path.
  // One pass over the sessions, reusable for as many lookups as the caller has:
  // decorating N worktrees used to be N scans of every session, each re-resolving
  // every session path synchronously (O(worktrees × sessions) blocking syscalls on
  // the event loop that also serves the terminal WebSockets).
  //
  // `resolve` is injectable so a caller that rebuilds this index several times a
  // second (the SSE broadcast) can memoize resolution across builds; the default
  // resolves uncached, which is what a one-off lookup wants.
  sessionIndex(resolve = realpath) {
    const index = new Map();
    for (const s of this.sessions.values()) {
      for (const p of [s.worktreePath, ...(s.repos || []).map((r) => r.worktreePath)]) {
        if (!p) continue;
        const key = resolve(p);
        // First session wins, matching the old first-match-in-insertion-order scan:
        // two sessions claiming one worktree is a bug, not a shape to average over.
        if (!index.has(key)) index.set(key, s);
      }
    }
    return index;
  }

  // The session (if any) whose promoted/adopted worktree is this path — used to
  // surface agent state on a Fleet worktree row. For a single lookup; anything
  // resolving many paths at once should build one sessionIndex() and reuse it.
  sessionForWorktree(worktreePath) {
    if (!worktreePath) return null;
    return this.sessionIndex().get(realpath(worktreePath)) || null;
  }

  // The feature identity of a worktree this session owns — the value that has to
  // match a name in state.js's features/groups list. Delegated to the one resolver
  // so a session and the Fleet rail can never disagree about which feature a
  // worktree is part of.
  featureOf({ repo, wtname, branch, path: p }) {
    return this.identity.of({ repo, wtname, branch, path: p });
  }

  // The NAME a worktree of this session should be given on disk. Deliberately NOT
  // `s.feature`: naming and grouping are different questions (server/identity.js),
  // and under the `branch`/`manifest` strategies the identity is a grouping key
  // (`123`, a manual group name), not a directory name. The session's own worktree
  // name is the authority; `s.feature` remains the last fallback so sessions
  // persisted before the two were told apart keep naming siblings exactly as before.
  worktreeNameFor(s) {
    const primary = (s.repos || []).find((r) => r.primary);
    return s.worktree || (primary && primary.worktree) || s.suggestedName || s.feature;
  }

  claudeCmd(session, { resume } = {}) {
    // Launch claude clean. On a FRESH launch the single-line seed rides along as
    // claude's final positional arg (see below) — no post-launch typing race. On
    // resume the conversation already contains it, so we don't re-send it.
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
    // Fresh launch → deliver the seed as claude's final positional (the prompt) arg.
    // On resume it's already in the conversation, so skip it.
    if (!resume && session.seed) parts.push(shq(session.seed));
    return parts.join(' ');
  }

  // Send `text` into a session's claude pane, but only once claude is actually the
  // foreground program AND (preferably) not mid-turn. If claude never comes up we
  // no-op and flag it for the UI rather than typing a command into a bare shell.
  // Used for live injections: /add-dir on add-repo and the promote "cd" guidance.
  async sendWhenReady(muxName, text, session) {
    const delays = [0, 400, 800, 1500, 2500];
    let sawClaude = false;
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]) await sleep(delays[i]);
      let cmd = '';
      try { cmd = this.mux.paneCommand ? await this.mux.paneCommand(muxName) : 'claude'; } catch { cmd = ''; }
      if (!cmd || isShell(cmd)) continue; // claude not in the foreground yet
      sawClaude = true;
      const st = session && session.state;
      const midTurn = st && st !== 'idle' && st !== 'waiting';
      if (midTurn && i < delays.length - 1) continue; // busy → back off and retry
      await this.mux.sendText(muxName, text);
      return { ok: true };
    }
    // Never saw claude → don't type into a shell; surface it so the UI can prompt.
    if (session) { session.activity = 'action pending (claude not ready)'; this._touch(session.id); }
    return { ok: false, skipped: true, reason: sawClaude ? 'busy' : 'no-claude' };
  }

  // Move the LIVE session into its worktree. `/cd` relocates BOTH Claude's working
  // directory and its transcript to the worktree's project storage (Claude Code
  // v2.1.169+), so every future `--resume` finds the conversation there. That is why
  // we flip `home` to the worktree only once the command was actually delivered — if
  // it wasn't, the transcript stays in the original dir and `home` must stay with it.
  async _anchorInWorktree(s) {
    if (!s || !s.worktreePath || s.home === s.worktreePath) return;
    const r = await this.sendWhenReady(s.muxName, `/cd ${s.worktreePath}`, s);
    if (r && r.ok) { s.home = s.worktreePath; this._touch(s.id); }
  }

  // Add a repo to this session's feature: create a same-named worktree there and
  // grant the live session access via /add-dir. Used by the UI button and the CLI
  // (so both David and claude can trigger it).
  async addRepo(id, { repo, repoPath }) {
    const s = this.get(id);
    if (!s) return { ok: false, error: 'no such session' };
    if ((s.repos || []).some((r) => r.repo === repo)) return { ok: true, already: true, session: s };
    const wtname = this.worktreeNameFor(s);
    const branch = s.branch || `feature/${wtname}`;
    const res = await worktree.create(repoPath, branch, wtname, {
      layout: this.layout,
      ...worktreeCopyOpts(this.cfg, repo),
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
    // grant the running session access, live (gated on claude being ready)
    await this.sendWhenReady(s.muxName, `/add-dir ${res.path}`, s);
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
    await this.sendWhenReady(s.muxName, `/add-dir ${worktreePath}`, s);
    this._touch(id);
    return { ok: true };
  }

  async create({ seed, repoPath, repoName, additionalRepos }) {
    const id = makeId('s_');
    const title = seed.title || 'New session';
    const name = slug(title);
    const muxName = muxNameFor(name, id);
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
      // A pre-promote session owns no worktree, so it has no feature identity yet —
      // there is nothing for a strategy to resolve. This is a placeholder that
      // promote() replaces with the real identity the moment a worktree exists.
      feature: name,
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
      seed: collapse(seedPrompt(seed)), // single-line seed, delivered as claude's launch arg
      active: true,
      createdAt: Date.now(),
      promotedAt: null,
    };
    this._writeHookSettings(session);
    this.sessions.set(id, session);

    const cmd = this.claudeCmd(session);
    const r = await this.mux.ensure(muxName, { cwd: repoPath, cmd, env: { WT_STUDIO_SESSION: id } });
    if (r.error) { session.state = 'stopped'; session.activity = `failed to start: ${r.error}`; }
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
    const muxName = muxNameFor(slug(wtname || title), id);
    const session = {
      id, title, source: s.source, sourceId: s.id || null, sourceUrl: s.url || null,
      repoName, repoPath, home: worktreePath, // launch/transcript dir (claude runs here) — so --resume finds it
      worktree: wtname, worktreePath, branch: branch || null,
      // The identity the worktree ALREADY has under the configured strategy — this
      // worktree exists on disk and features.js is grouping it right now, so the
      // session has to record the same answer, not a slug of its own devising.
      feature: this.featureOf({ repo: repoName, wtname, branch, path: worktreePath }),
      repos: [{ repo: repoName, repoPath, worktree: wtname, worktreePath, branch: branch || null, primary: true }],
      pendingRepos: [],
      suggestedBranch: branch || null, suggestedName: wtname || slug(title),
      muxName, claudeSessionId: null, state: 'idle', activity: 'starting…',
      tabs: [{ title: 'claude' }], seed: seed ? collapse(seedPrompt(seed)) : null, active: true,
      createdAt: Date.now(), promotedAt: Date.now(), adopted: true,
    };
    this._writeHookSettings(session);
    this.sessions.set(id, session);
    const cmd = this.claudeCmd(session);
    const r = await this.mux.ensure(muxName, { cwd: worktreePath, cmd, env: { WT_STUDIO_SESSION: id } });
    if (r.error) { session.state = 'stopped'; session.activity = `failed to start: ${r.error}`; }
    this._touch(id);
    return session;
  }

  // Files dirty in the main checkout (uncommitted work that would be stranded in
  // main when we branch the worktree cleanly off the default branch).
  async _dirtyMain(repoPath) {
    try {
      const r = await run('git', ['-C', repoPath, 'status', '--porcelain']);
      if (r.code !== 0) return [];
      return r.stdout.split('\n').filter(Boolean).map((l) => l.slice(3));
    } catch { return []; }
  }

  async promote(id, { branch, name, confirm } = {}) {
    const s = this.get(id);
    if (!s) return { ok: false, error: 'no such session' };
    if (s.worktreePath) return { ok: false, error: 'already promoted' };
    // Claude launched with cwd in the main checkout; the worktree is branched clean
    // off the default branch, so pre-promote edits stay in main. Warn (don't strand
    // silently) unless the caller has already confirmed.
    if (!confirm) {
      const dirty = await this._dirtyMain(s.repoPath);
      if (dirty.length) return { ok: false, needsConfirm: true, dirty };
    }
    const br = branch || s.suggestedBranch;
    const wtName = name || s.suggestedName;
    const res = await worktree.create(s.repoPath, br, wtName, {
      unique: true, // auto-suffix on collision rather than fail
      layout: this.layout,
      ...worktreeCopyOpts(this.cfg, s.repoName),
    });
    if (!res.ok) return res;
    s.worktree = res.name;
    s.worktreePath = res.path;
    s.branch = res.branch;
    // The worktree is NAMED res.name; which feature it belongs to is a separate
    // question the identity resolver answers (under `basename` the two coincide,
    // which is why storing the name looked right for so long).
    s.feature = this.featureOf({ repo: s.repoName, wtname: res.name, branch: res.branch, path: res.path });
    s.promotedAt = Date.now();
    // record the primary repo's worktree
    const primary = (s.repos || []).find((r) => r.primary);
    if (primary) { primary.worktree = res.name; primary.worktreePath = res.path; primary.branch = res.branch; }
    // rename the mux session to the worktree (best-effort; harmless if unsupported)
    const newMux = `wts-${res.name}`.slice(0, 60);
    if (await this.mux.rename(s.muxName, newMux)) s.muxName = newMux;
    // move the running session into the worktree — relocates cwd AND transcript,
    // so resume is seamless from here on (gated on claude being ready)
    await this._anchorInWorktree(s);
    this._touch(id);
    // fan out to any repos chosen up front, serialized (each addRepo is itself gated)
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
    // clean up the per-session hook settings file (best-effort)
    if (s.settingsFile) { try { fs.unlinkSync(s.settingsFile); } catch { /* */ } }
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
      // The seed is delivered as claude's launch arg (see claudeCmd) — nothing to inject.
    }
    const m = status.mapEvent(event, payload);
    if (m) { s.state = m.state; if (m.activity) s.activity = m.activity; }
    // the agent's own process exited — mark inactive so the UI offers Reactivate
    if (event === 'SessionEnd') s.active = false;
    s.lastEventAt = Date.now();
    this._touch(id);
    // Republish the raw lifecycle event. 'change' fires on every touch and says
    // nothing about WHICH event caused it; listeners that only care about turn
    // boundaries (Stop → the transcript now has a complete turn appended) need the
    // event name, not a state diff.
    this.emit('hook', { id, event, payload });
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
    // A promoted session whose worktree vanished can't continue — flag it instead of
    // faking a resume into a dead directory.
    if (s.worktreePath && !fs.existsSync(s.worktreePath)) {
      s.active = true; s.state = 'stopped'; s.activity = 'worktree missing';
      this._touch(id);
      return { ok: false, error: 'worktree missing' };
    }
    // Regenerate the hook settings file so it tracks the current install path/port —
    // makes a relaunch self-heal after the studio dir is moved or the port changes.
    this._writeHookSettings(s);
    const cmd = this.claudeCmd(s, { resume: !!s.claudeSessionId });
    // Resume from the transcript's home dir so --resume finds the conversation. For a
    // promoted session home is already the worktree (moved there at promote), so it
    // launches straight into the worktree; _anchorInWorktree self-heals the rare case
    // where the promote-time /cd never landed.
    let cwd = s.home || s.repoPath;
    if (!cwd || !fs.existsSync(cwd)) cwd = s.repoPath;
    const r = await this.mux.ensure(s.muxName, { cwd, cmd, env: { WT_STUDIO_SESSION: s.id } });
    s.active = true;
    s.state = 'idle';
    s.activity = s.claudeSessionId ? 'resumed' : 'restarted';
    this._touch(id);
    if (!r.error) this._anchorInWorktree(s).catch(() => {});
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

  // Self-heal live state against the multiplexer: a session whose tmux session was
  // killed out-of-band (manual `tmux kill-session`, crash) shows a stale live state
  // until an action fails. Flip any such session to stopped. Cheap: one has-session
  // per active session. Already-stopped/deactivated sessions are left untouched, and
  // a query error is treated as "still alive" so we never flip on a transient failure.
  async reconcile() {
    for (const s of this.sessions.values()) {
      if (!s.muxName || s.active === false || s.state === 'stopped') continue;
      let alive = true;
      try { alive = await this.mux.hasSession(s.muxName); } catch { alive = true; }
      if (alive) continue;
      s.state = 'stopped';
      s.active = false;
      s.activity = 'session ended';
      this._touch(s.id);
    }
  }

  // Recreate every persisted session after a restart, resuming the conversation.
  //
  // Each session is relaunched inside its own guard, because one that cannot be
  // relaunched says nothing about the next one. Without it a single throw took out
  // the whole pass: `_writeHookSettings` is a mkdirSync + writeFileSync, so one
  // EACCES or ENOSPC escaped the loop, every LATER session was silently never
  // relaunched, and `_save()` never ran either — leaving the on-disk state claiming
  // they were fine. A session that fails is marked and reported; the pass goes on.
  async restore() {
    let n = 0;
    for (const s of this.all()) {
      if (!s.muxName) continue;
      if (s.active === false) continue;
      try {
        if (await this.mux.hasSession(s.muxName)) { s.activity = 'reattached'; await this._syncTabs(s); continue; }
        // A promoted session whose worktree is gone can't be resumed meaningfully —
        // flag it rather than launch a dead pane and claim success.
        if (s.worktreePath && !fs.existsSync(s.worktreePath)) {
          s.state = 'stopped'; s.activity = 'worktree missing';
          continue;
        }
        // Refresh the hook settings file to the current install path/port before relaunch.
        this._writeHookSettings(s);
        const cmd = this.claudeCmd(s, { resume: !!s.claudeSessionId });
        // Resume from the transcript's home dir so --resume finds the conversation.
        // Promoted sessions already have home = worktree (moved at promote time).
        let cwd = s.home || s.repoPath;
        if (!cwd || !fs.existsSync(cwd)) cwd = s.repoPath;
        await this.mux.ensure(s.muxName, { cwd, cmd, env: { WT_STUDIO_SESSION: s.id } });
        // restore recreates only the primary claude window — drop any stale extra
        // tabs so the tab strip matches the windows that actually exist.
        s.tabs = [{ title: 'claude' }];
        s.state = 'idle';
        s.activity = s.claudeSessionId ? 'resumed' : 'restarted';
        // self-heal a promote whose /cd never landed (normally a no-op here).
        this._anchorInWorktree(s).catch(() => {});
        n++;
      } catch (e) {
        s.state = 'stopped';
        s.activity = `restore failed: ${e.message}`;
        console.error(`[wt-studio] could not restore session ${s.id} (${s.title || 'untitled'}): ${e.message}`);
      }
    }
    this._save();
    this.emit('change', { type: 'restore', count: n });
    return n;
  }
}

module.exports = { SessionManager, deriveBranch, seedPrompt, muxNameFor };
