// The session manager: the origin is a real Claude Code process running inside
// a multiplexer session. Create (seeded on CLAUDE.md, in the main repo) →
// promote to a worktree (same session continues) → pop-out / tabs / restore.
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { readJsonState, writeJson, makeId, shortId, realpath, slug, shq, run } from './util.ts';
import * as status from './status.ts';
import * as worktree from './worktree.ts';
import * as layoutMod from './layout.ts';
import { linkSessionMemory } from './claude-memory.ts';
import { describe as describeCheckout, prepareForSession } from './checkout.ts';
import { createIdentity } from './identity.ts';
import type { HookPayload } from './status.ts';
import type { WorktreeCreateResult } from './worktree.ts';
import type { ResolvedLayout } from './layout.ts';
import type { Identity, IdentityInput } from './identity.ts';
import type { Config, PartialDeep, Session, SourceSeed, SessionTab } from './types.ts';
const { worktreeCopyOpts } = worktree;

// ---- the collaborators, typed by what this file asks of them ----------------

/** What a session's claude process is launched into. */
export interface MuxLaunchOptions {
  cwd?: string;
  cmd?: string;
  env?: Record<string, string>;
}

/** `ensure()`'s answer: whether it had to create the session, and why it couldn't. */
export interface MuxEnsureResult {
  created?: boolean;
  error?: string;
}

export interface MuxNewTabOptions {
  title?: string;
  cwd?: string;
  cmd?: string;
}

/**
 * The id a seeded tab carries until the first `_syncTabs` replaces it with the
 * multiplexer's real window id. It deliberately cannot collide with one: tmux window
 * ids are always `@N`. A tab still wearing this has never been reconciled, so
 * `#tabAt` falls through to the positional lookup for it and nothing else.
 */
export const PENDING_TAB = 'pending';

export interface MuxNewTabResult {
  ok: boolean;
  error?: string;
  /** The window id the driver assigned — what the tab is addressed by from now on. */
  id?: string;
}

/** One multiplexer window, as `listTabs()` reports it. */
export interface MuxTab {
  id: string;
  title: string;
  active: boolean;
}

/**
 * The multiplexer driver, typed by the members this file calls and no more — the
 * same reason server/term.ts declares its own two-member `TerminalMux`. The
 * concrete driver is server/multiplexer/tmux.ts; naming the surface rather than
 * importing the driver is what lets a test stand a double in its place, and what
 * a driver gets checked against.
 */
export interface SessionMux {
  /** The driver's own name ('tmux') — not called here, but every driver and every
   *  double carries it, and the topology payload reports it. */
  name: string;
  /** Create the multiplexer session if it isn't already there, and launch `cmd` in it. */
  ensure(name: string, opts?: MuxLaunchOptions): Promise<MuxEnsureResult>;
  hasSession(name: string): Promise<boolean>;
  kill(name: string): Promise<unknown>;
  rename(oldName: string, newName: string): Promise<boolean>;
  sendText(name: string, text: string, target?: string): Promise<unknown>;
  /** The pane's foreground program; '' when it can't be read. */
  paneCommand(name: string, target?: string): Promise<string>;
  newTab(name: string, opts?: MuxNewTabOptions): Promise<MuxNewTabResult>;
  listTabs(name: string): Promise<MuxTab[]>;
  selectTab(name: string, id: string | number): Promise<boolean>;
  closeTab(name: string, id: string | number): Promise<boolean>;
  renameTab(name: string, id: string | number, title: string): Promise<boolean>;
  /**
   * The command node-pty runs to attach a client. Also not called here: server/term.ts
   * reaches it through `manager.mux` for the same reason, and declares its own
   * two-member `TerminalMux` to say so.
   */
  attachSpawn(name: string): MuxAttachSpec;
}

/** What `attachSpawn` hands back for node-pty to run. */
export interface MuxAttachSpec {
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * The upstream record a session is opened from: a server/sources `SourceSeed`, or
 * the free-text stand-in `_doAdopt` builds when a worktree is opened without one.
 * Source and title are the two a session is built out of unconditionally; the rest
 * has a fallback at every use.
 */
export type SessionSeed = Partial<SourceSeed> & { source: string; title: string };

export interface SessionCreateArgs {
  seed: SessionSeed;
  repoPath: string;
  repoName: string;
  additionalRepos?: Array<{ repo: string; repoPath: string }>;
}

export interface SessionAdoptArgs {
  worktreePath: string;
  repoName: string;
  repoPath: string;
  branch?: string | null;
  wtname?: string | null;
  seed?: SessionSeed;
}

export interface SessionAttachArgs {
  repo: string;
  repoPath: string;
  worktreePath: string;
  branch?: string | null;
  wtname?: string | null;
}

/**
 * What `promote()` answers.
 *
 * Four outcomes share one shape rather than a discriminated union, because the route
 * reads two independent flags off it: `needsConfirm` is a 200 that asks again (a dirty
 * main checkout), `ok` decides 200-vs-400, and a failed `worktree.create()` is returned
 * verbatim so the caller keeps the name and path it was going to use.
 */
export interface PromoteResult {
  ok: boolean;
  error?: string;
  /** A dirty main checkout: not a failure, a question. The client re-prompts with `confirm`. */
  needsConfirm?: boolean;
  /** The uncommitted paths that raised `needsConfirm`. */
  dirty?: string[];
  /**
   * Commits on the main checkout's current branch that the default base lacks — the
   * other thing a promote leaves behind. `commits` is `git log --oneline` lines, newest
   * first, so the dialog can show what would be stranded rather than only a count.
   */
  ahead?: { branch: string; base: string; commits: string[] };
  /** How many commits came along, when the caller asked to bring them. */
  broughtCommits?: number;
  /** How many uncommitted paths were moved into the worktree. */
  brought?: number;
  session?: Session;
  worktree?: WorktreeCreateResult;
  /** Carried through from a failed `worktree.create()`. */
  path?: string;
  name?: string;
  branch?: string;
}

/** A Claude Code hook body: server/status.ts's view plus the id SessionStart carries. */
export interface HookBody extends HookPayload {
  session_id?: string;
}

const sleep = (ms: number) =>
  new Promise<void>((r) => {
    setTimeout(r, ms);
  });

// Collapse a (possibly multi-line) seed to a single line so it can ride along as
// one launch arg / one submitted message.
function collapse(text: string | null | undefined): string {
  return (text || '').replace(/\s*\n\s*/g, ' ').trim();
}

// Is `cmd` a bare login/interactive shell (i.e. claude is NOT the foreground
// program in the pane)? tmux's pane_current_command may be prefixed with '-'.
function isShell(cmd: string | null | undefined): boolean {
  const c = String(cmd || '').replace(/^-/, '');
  return /^(?:bash|zsh|sh|fish|dash|ksh|csh|tcsh|login)$/i.test(c);
}

// tmux session name for a session: `wts-<feature>-<id tail>`, capped at 60 chars.
// The cap is taken out of the FEATURE, never out of the tail — two sessions of the
// same feature are told apart only by that suffix, and truncating the whole string
// (which is what this did while ids were tiny) silently eats it now that ids are
// UUIDs. muxName is persisted per session, so existing sessions keep their name.
const MUX_MAX = 60;
function muxNameFor(name: string | null | undefined, id: string): string {
  const tail = shortId(id);
  const room = MUX_MAX - 'wts-'.length - 1 - tail.length;
  return `wts-${String(name || 'session').slice(0, Math.max(1, room))}-${tail}`;
}

function deriveBranch(seed: Pick<SessionSeed, 'title' | 'body' | 'id'>): string {
  const s = slug(seed.title);
  const type = /\b(fix|bug|error|broken|regression|crash|fails?)\b/i.test(`${seed.title} ${seed.body}`)
    ? 'fix'
    : 'feature';
  const num = seed.id && /^\d+$/.test(String(seed.id)) ? `${seed.id}-` : '';
  return `${type}/${num}${s}`;
}

function seedPrompt(seed: SessionSeed): string {
  // Send the user's prompt as-is. Free text: exactly what they typed (no wrapper,
  // no duplication). Issue sources: the issue title + body + link (that IS the ask).
  if (seed.source === 'freetext') return (seed.body || seed.title || '').trim();
  const parts = [seed.title];
  if (seed.body?.trim()) parts.push('', seed.body.trim());
  if (seed.url) parts.push('', seed.url);
  return parts.join('\n').trim();
}

class SessionManager extends EventEmitter {
  cfg: PartialDeep<Config>;
  /**
   * The driver, as much of it as this manager was handed. Partial rather than a
   * whole `SessionMux` because a test stands in a double covering only the calls
   * the path under test makes; a path that reaches past its double throws exactly
   * as it did before this file carried types, which is what the `!`s below say.
   */
  mux: SessionMux;
  identity: Identity;
  layout: ResolvedLayout;
  /**
   * server/config.ts stamps `_stateDir` onto every config before anything else
   * sees one, so it is always there; the type says otherwise only because every
   * consumer takes the config as PartialDeep, which describes what a hand-built
   * cfg may omit rather than what a loaded one carries. Narrowed once, here.
   */
  stateDir: string;
  file: string;
  sessions: Map<string, Session>;
  _adopting: Set<string>;

  // `identity` is the shared server/identity.ts resolver (server.ts builds one and
  // hands the same instance to state.ts/servers.ts). A session stores the feature
  // IDENTITY it belongs to, and that has to be the same answer features.ts groups
  // by — otherwise `POST /group/pr { group: session.feature }` looks up a feature
  // that doesn't exist under any strategy but `basename`.
  /**
   * @param mux         the multiplexer adapter (server/multiplexer)
   * @param identity    a server/identity.ts resolver; built from cfg if omitted
   */
  constructor(cfg: PartialDeep<Config>, mux: SessionMux, identity?: Identity) {
    super();
    this.cfg = cfg;
    this.mux = mux;
    this.identity = identity || createIdentity(cfg);
    this.layout = layoutMod.resolve(cfg); // where the worktrees this manager creates live
    this.stateDir = cfg._stateDir!;
    this.file = path.join(this.stateDir, 'sessions.json');
    this.sessions = new Map();
    this._adopting = new Set(); // worktreePaths with an adopt in flight (dedup guard)
    // readJsonState, not readJson: a corrupt sessions.json must be preserved rather
    // than silently replaced by an empty one on the next save — it holds the
    // claudeSessionId values that tie each session to a live claude conversation.
    for (const s of readJsonState<Session[]>(this.file, []) || []) this.sessions.set(s.id, s);
  }

  /** Every session, newest first. */
  all(): Session[] {
    return [...this.sessions.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }
  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }
  _save(): void {
    writeJson(this.file, this.all());
  }
  _touch(id: string): void {
    this._save();
    this.emit('change', { type: 'session', id });
  }

  // (Re)write a session's Claude Code hook settings file and record that its URLs now
  // carry the boot token. The flag is what lets the /hook receiver keep accepting
  // tokenless reports from sessions whose claude was launched by an older build —
  // that process already read its settings file and will never re-read it. The
  // exemption clears itself the moment the session is relaunched through here.
  _writeHookSettings(s: Session): void {
    // `web.port` is the same invariant as `stateDir`: config.defaults() always
    // carries it and only PartialDeep makes it look absent. Read live rather than
    // captured, because this call is what makes a relaunch pick up a changed port.
    s.settingsFile = status.settingsFile(this.stateDir, s.id, this.cfg.web!.port!, this.cfg._token);
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
  /** @returns worktree path → session */
  sessionIndex(resolve: (p: string) => string = realpath): Map<string, Session> {
    const index = new Map<string, Session>();
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
  sessionForWorktree(worktreePath: string): Session | null {
    if (!worktreePath) return null;
    return this.sessionIndex().get(realpath(worktreePath)) || null;
  }

  // The feature identity of a worktree this session owns — the value that has to
  // match a name in state.ts's features/groups list. Delegated to the one resolver
  // so a session and the Fleet rail can never disagree about which feature a
  // worktree is part of.
  /** @returns the feature identity, under the configured strategy */
  featureOf({ repo, wtname, branch, path: p }: IdentityInput): string {
    return this.identity.of({ repo, wtname, branch, path: p });
  }

  // The NAME a worktree of this session should be given on disk. Deliberately NOT
  // `s.feature`: naming and grouping are different questions (server/identity.ts),
  // and under the `branch`/`manifest` strategies the identity is a grouping key
  // (`123`, a manual group name), not a directory name. The session's own worktree
  // name is the authority; `s.feature` remains the last fallback so sessions
  // persisted before the two were told apart keep naming siblings exactly as before.
  worktreeNameFor(s: Session): string {
    const primary = (s.repos || []).find((r) => r.primary);
    return s.worktree || primary?.worktree || s.suggestedName || s.feature;
  }

  /**
   * Let this session reach its repos' Claude Code memories.
   *
   * Claude Code keys memory on the session's absolute cwd, and Studio runs every session
   * in a worktree — a different path from the checkout. So a repo's accumulated memories
   * (commit style, review conventions) were invisible to every session Studio started,
   * and anything a session learned was written to a directory that died with the
   * worktree. See server/claude-memory.ts for the mechanism and its refusals.
   *
   * Called immediately before each launch rather than at promote: it is idempotent (the
   * steady state is one lstat per repo), which makes it self-healing for the worktrees
   * that already exist and for any made outside Studio by a plain `wt`.
   */
  _shareMemories(s: Session): void {
    for (const { repo, outcome } of linkSessionMemory(s.repos)) {
      if (outcome.status === 'linked') {
        console.log(`[wt-studio] ${repo}: worktree now shares the checkout's Claude memories`);
      } else if (outcome.status === 'occupied') {
        // Loud: the session is starting WITHOUT the repo's memories and that is a
        // silent behaviour change unless it is said out loud.
        console.warn(
          `[wt-studio] ${repo}: left its memory directory alone (${outcome.reason}: ${outcome.at})`,
        );
      } else if (outcome.status === 'error') {
        console.warn(`[wt-studio] ${repo}: could not share Claude memories: ${outcome.error}`);
      }
    }
  }

  claudeCmd(session: Session, { resume }: { resume?: boolean } = {}): string {
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
    const parts = [CLEAN, this.cfg.claude?.cmd || 'claude', '--settings', shq(session.settingsFile)];
    if (resume && session.claudeSessionId) parts.push('-r', shq(session.claudeSessionId));
    // grant tool access to any sibling-repo worktrees this session already owns
    for (const r of session.repos || []) {
      if (!r.primary && r.worktreePath) parts.push('--add-dir', shq(r.worktreePath));
    }
    // tell claude it can pull in another repo itself (single line — no newlines,
    // which would break the multiplexer layout)
    // `.ts`, not `.js`: the CLI was migrated with the rest of the server and this string
    // was not. Every session's system prompt told the agent to run a path that does not
    // exist, so `add-repo` failed from inside a session with a module-not-found the user
    // had to diagnose. Pinned by a test that stats the file.
    const cli = path.join(import.meta.dirname, '..', 'bin', 'wt-studio.ts');
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
  async sendWhenReady(
    muxName: string,
    text: string,
    session?: Session | null,
  ): Promise<{ ok: boolean; skipped?: boolean; reason?: string }> {
    const delays = [0, 400, 800, 1500, 2500];
    let sawClaude = false;
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]) await sleep(delays[i]);
      let cmd = '';
      try {
        cmd = this.mux.paneCommand ? await this.mux.paneCommand(muxName) : 'claude';
      } catch {
        cmd = '';
      }
      if (!cmd || isShell(cmd)) continue; // claude not in the foreground yet
      sawClaude = true;
      const st = session?.state;
      const midTurn = st && st !== 'idle' && st !== 'waiting';
      if (midTurn && i < delays.length - 1) continue; // busy → back off and retry
      await this.mux.sendText(muxName, text);
      return { ok: true };
    }
    // Never saw claude → don't type into a shell; surface it so the UI can prompt.
    if (session) {
      session.activity = 'action pending (claude not ready)';
      this._touch(session.id);
    }
    return { ok: false, skipped: true, reason: sawClaude ? 'busy' : 'no-claude' };
  }

  // Move the LIVE session into its worktree. `/cd` relocates BOTH Claude's working
  // directory and its transcript to the worktree's project storage (Claude Code
  // v2.1.169+), so every future `--resume` finds the conversation there. That is why
  // we flip `home` to the worktree only once the command was actually delivered — if
  // it wasn't, the transcript stays in the original dir and `home` must stay with it.
  async _anchorInWorktree(s: Session | null | undefined): Promise<void> {
    if (!s?.worktreePath || s.home === s.worktreePath) return;
    const r = await this.sendWhenReady(s.muxName, `/cd ${s.worktreePath}`, s);
    if (r?.ok) {
      s.home = s.worktreePath;
      this._touch(s.id);
    }
  }

  // Add a repo to this session's feature: create a same-named worktree there and
  // grant the live session access via /add-dir. Used by the UI button and the CLI
  // (so both David and claude can trigger it).
  async addRepo(id: string, { repo, repoPath }: { repo: string; repoPath: string }) {
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
        const a = await this.attachRepo(id, {
          repo,
          repoPath,
          worktreePath: res.path,
          branch: res.branch,
          wtname: res.name,
        });
        return a.ok
          ? {
              ok: true,
              session: s,
              worktree: { name: res.name, path: res.path, branch: res.branch },
              attached: true,
            }
          : a;
      }
      return res;
    }
    s.repos.push({
      repo,
      repoPath,
      worktree: res.name,
      worktreePath: res.path,
      branch: res.branch,
      primary: false,
    });
    // grant the running session access, live (gated on claude being ready)
    await this.sendWhenReady(s.muxName, `/add-dir ${res.path}`, s);
    this._touch(id);
    return { ok: true, session: s, worktree: res };
  }

  // Attach an EXISTING worktree to a session (no creation) and grant /add-dir.
  // Used when starting one session for a feature whose worktrees already exist.
  async attachRepo(id: string, { repo, repoPath, worktreePath, branch, wtname }: SessionAttachArgs) {
    const s = this.get(id);
    if (!s) return { ok: false };
    if ((s.repos || []).some((r) => r.worktreePath === worktreePath)) return { ok: true, already: true };
    s.repos.push({
      repo,
      repoPath,
      worktree: wtname ?? null,
      worktreePath,
      branch: branch ?? null,
      primary: false,
    });
    await this.sendWhenReady(s.muxName, `/add-dir ${worktreePath}`, s);
    this._touch(id);
    return { ok: true };
  }

  async create({ seed, repoPath, repoName, additionalRepos }: SessionCreateArgs): Promise<Session> {
    /*
     * Start from the repo's default branch, at its latest commit.
     *
     * The main checkout is whatever you last left it on, and a new session inherits that:
     * a half-finished branch, someone else's fix, scratch files. The agent reads it as
     * its starting state, and promote then offers to carry it along.
     *
     * NEVER destructive — see server/checkout.ts. It fetches (read-only), switches only a
     * checkout with no modified tracked files, and fast-forwards only. Anything it
     * declines to do is reported on the session rather than silently skipped.
     *
     * Skipped when another unpromoted session already lives in this checkout: they share
     * one working copy, and moving it under a running agent is not ours to do.
     */
    const shared = this.all().some(
      (s) => s.active && !s.worktreePath && realpath(s.repoPath) === realpath(repoPath),
    );
    const checkout = await prepareForSession(repoPath, { switchBranch: !shared });

    const id = makeId('s_');
    const title = seed.title || 'New session';
    const name = slug(title);
    const muxName = muxNameFor(name, id);
    const session: Session = {
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
      // Say which branch it started on when that is not simply "the default, up to date" —
      // a session that began somewhere unexpected should not be silent about it.
      activity: describeCheckout(checkout) || 'starting…',
      tabs: [{ id: PENDING_TAB, title: 'claude' }],
      seed: collapse(seedPrompt(seed)), // single-line seed, delivered as claude's launch arg
      active: true,
      createdAt: Date.now(),
      promotedAt: null,
    };
    this._writeHookSettings(session);
    this.sessions.set(id, session);

    this._shareMemories(session);
    const cmd = this.claudeCmd(session);
    const r = await this.mux.ensure(muxName, { cwd: repoPath, cmd, env: { WT_STUDIO_SESSION: id } });
    if (r.error) {
      session.state = 'stopped';
      session.activity = `failed to start: ${r.error}`;
    } else await this._syncTabs(session); // trade the placeholder id for the real window id
    this._touch(id);
    return session;
  }

  // Start a session in a worktree that already exists (no promote step).
  /**
   * Open a session on a worktree that already exists on disk (Fleet's "Start
   * session here"). `seed` is optional: without one the worktree name is the title.
   * @returns null while an adopt of the same worktree is already in flight
   */
  async adopt({
    worktreePath,
    repoName,
    repoPath,
    branch,
    wtname,
    seed,
  }: SessionAdoptArgs): Promise<Session | null> {
    // dedup: never open two sessions for the same worktree, even on concurrent calls
    const existing = this.sessionForWorktree(worktreePath);
    if (existing) return existing;
    if (this._adopting.has(worktreePath)) return null;
    this._adopting.add(worktreePath);
    try {
      return await this._doAdopt({ worktreePath, repoName, repoPath, branch, wtname, seed });
    } finally {
      this._adopting.delete(worktreePath);
    }
  }

  async _doAdopt({
    worktreePath,
    repoName,
    repoPath,
    branch,
    wtname,
    seed,
  }: SessionAdoptArgs): Promise<Session> {
    const s: SessionSeed = seed || {
      source: 'freetext',
      title: wtname || path.basename(worktreePath),
      body: '',
      url: null,
    };
    const id = makeId('s_');
    const title = s.title;
    const muxName = muxNameFor(slug(wtname || title), id);
    const session: Session = {
      id,
      title,
      source: s.source,
      sourceId: s.id || null,
      sourceUrl: s.url || null,
      repoName,
      repoPath,
      home: worktreePath, // launch/transcript dir (claude runs here) — so --resume finds it
      worktree: wtname ?? null,
      worktreePath,
      branch: branch || null,
      // The identity the worktree ALREADY has under the configured strategy — this
      // worktree exists on disk and features.ts is grouping it right now, so the
      // session has to record the same answer, not a slug of its own devising.
      feature: this.featureOf({ repo: repoName, wtname: wtname ?? undefined, branch, path: worktreePath }),
      repos: [
        {
          repo: repoName,
          repoPath,
          worktree: wtname ?? null,
          worktreePath,
          branch: branch || null,
          primary: true,
        },
      ],
      pendingRepos: [],
      suggestedBranch: branch || null,
      suggestedName: wtname || slug(title),
      muxName,
      claudeSessionId: null,
      state: 'idle',
      activity: 'starting…',
      tabs: [{ id: PENDING_TAB, title: 'claude' }],
      seed: seed ? collapse(seedPrompt(seed)) : null,
      active: true,
      createdAt: Date.now(),
      promotedAt: Date.now(),
      adopted: true,
    };
    this._writeHookSettings(session);
    this.sessions.set(id, session);
    this._shareMemories(session);
    const cmd = this.claudeCmd(session);
    const r = await this.mux.ensure(muxName, { cwd: worktreePath, cmd, env: { WT_STUDIO_SESSION: id } });
    if (r.error) {
      session.state = 'stopped';
      session.activity = `failed to start: ${r.error}`;
    } else await this._syncTabs(session); // trade the placeholder id for the real window id
    this._touch(id);
    return session;
  }

  // Files dirty in the main checkout (uncommitted work that would be stranded in
  // main when we branch the worktree cleanly off the default branch).
  async _dirtyMain(repoPath: string): Promise<string[]> {
    try {
      const r = await run('git', ['-C', repoPath, 'status', '--porcelain']);
      if (r.code !== 0) return [];
      return r.stdout
        .split('\n')
        .filter(Boolean)
        .map((l) => l.slice(3));
    } catch {
      return [];
    }
  }

  /**
   * Commits sitting on the main checkout's CURRENT branch that the default base does
   * not have yet.
   *
   * This is the other half of "what stays behind when you promote", and the half that
   * used to be silent. A new worktree is cut from `origin/HEAD`, so work you already
   * COMMITTED in the main checkout is not in it either — and unlike dirty files, that
   * got no warning at all. Reading the list lets promote say what would be left, and
   * offer to cut from HEAD instead.
   *
   * Empty is the normal, healthy answer: it means the main checkout has nothing the
   * base is missing, so branching from either point gives the same tree.
   */
  async _aheadOfBase(repoPath: string): Promise<{ branch: string; base: string; commits: string[] }> {
    const empty = { branch: '', base: '', commits: [] };
    try {
      const head = await run('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD']);
      const branch = head.stdout.trim();
      // Detached HEAD has no branch to be "ahead" of and no sensible thing to offer.
      if (!branch || branch === 'HEAD') return empty;
      const sym = await run('git', [
        '-C',
        repoPath,
        'symbolic-ref',
        '--quiet',
        '--short',
        'refs/remotes/origin/HEAD',
      ]);
      const base = sym.stdout.trim();
      if (!base) return empty;
      /*
       * `--cherry-pick --right-only` with THREE dots, not a plain `base..HEAD`.
       *
       * Two dots asks "which commits are not in the base by SHA", and a rebased or
       * squashed merge changes the sha while keeping the change — so a branch whose work
       * is already fully merged still reported one commit "stranded", and promote offered
       * to copy something that was already upstream. `--cherry-pick` compares patch-ids,
       * which is the question actually being asked: is this CHANGE missing?
       *
       * Proven on a real repo: `origin/develop..HEAD` listed one commit whose patch-id
       * was identical to develop's own tip.
       */
      const log = await run('git', [
        '-C',
        repoPath,
        'log',
        '--oneline',
        '--no-decorate',
        '--cherry-pick',
        '--right-only',
        `${base}...HEAD`,
      ]);
      if (log.code !== 0) return empty;
      return { branch, base, commits: log.stdout.split('\n').filter(Boolean) };
    } catch {
      return empty;
    }
  }

  /**
   * Carry the main checkout's uncommitted work into a freshly made worktree.
   *
   * Stash, then pop in the worktree — one git operation each way, and the stash is the
   * receipt. That matters because the worktree is branched off the DEFAULT branch while
   * main is usually on something else, so the replay can genuinely conflict.
   *
   * On conflict the stash is LEFT INTACT and the failure is reported. Never
   * `stash drop` on a failed pop: the entry is the only remaining copy of that work,
   * and dropping it to keep the return shape tidy would destroy it. A user told
   * "couldn't apply — your changes are in stash@{0}" has lost nothing.
   */
  async _moveDirtyInto(
    repoPath: string,
    worktreePath: string,
  ): Promise<{ ok: boolean; error?: string; moved?: number }> {
    const before = await this._dirtyMain(repoPath);
    if (!before.length) return { ok: true, moved: 0 };

    /*
     * Refuse rather than sweep up a worktree. A `nested` layout puts checkouts inside
     * the repo, and worktree.create() only WARNS when that directory is not gitignored
     * — so on a repo that ignored the warning, the dirty list contains the other
     * worktrees themselves. Stashing that with --include-untracked would move every
     * one of them into the stash and delete them from disk. Bailing out costs the user
     * one gitignore line; the alternative costs them their checkouts.
     */
    const container = path.basename(path.dirname(worktreePath));
    const swept = before.find((l) => l.slice(3).replace(/^"|"$/g, '').startsWith(`${container}/`));
    if (swept) {
      return {
        ok: false,
        error:
          `refusing to move changes: "${container}/" is not gitignored in ${repoPath}, ` +
          `so it shows as uncommitted work and would be stashed along with your edits. ` +
          `Add "${container}/" to .gitignore, then promote again.`,
      };
    }

    const label = `wt-studio: promote ${new Date().toISOString()}`;
    // --include-untracked: a new file is the commonest thing to be sitting on, and
    // leaving those behind while moving the edits would split one change in half.
    const push = await run('git', ['-C', repoPath, 'stash', 'push', '--include-untracked', '-m', label]);
    if (push.code !== 0)
      return { ok: false, error: `could not stash: ${push.stderr.trim() || push.stdout.trim()}` };

    const pop = await run('git', ['-C', worktreePath, 'stash', 'pop']);
    if (pop.code !== 0) {
      return {
        ok: false,
        error:
          `worktree created, but your changes could not be replayed onto ${worktreePath}: ` +
          `${pop.stderr.trim() || pop.stdout.trim()}. They are safe in the stash — ` +
          `\`git stash list\` shows "${label}"; \`git stash pop\` in either checkout retries.`,
      };
    }
    return { ok: true, moved: before.length };
  }

  async promote(
    id: string,
    {
      branch,
      name,
      confirm,
      bringChanges,
      bringCommits,
    }: {
      branch?: string;
      name?: string;
      confirm?: boolean;
      bringChanges?: boolean;
      bringCommits?: boolean;
    } = {},
  ): Promise<PromoteResult> {
    const s = this.get(id);
    if (!s) return { ok: false, error: 'no such session' };
    if (s.worktreePath) return { ok: false, error: 'already promoted' };
    // Claude launched with cwd in the main checkout; the worktree is branched clean
    // off the default branch, so pre-promote edits stay in main unless asked to come
    // along. Warn (don't strand silently) unless the caller has already decided.
    const ahead = await this._aheadOfBase(s.repoPath);
    if (!confirm && !bringChanges && !bringCommits) {
      const dirty = await this._dirtyMain(s.repoPath);
      // One question covering both halves of what would be left behind, because both
      // can be true at once and answering them in two dialogs reads as a nag.
      if (dirty.length || ahead.commits.length) {
        return { ok: false, needsConfirm: true, dirty, ahead };
      }
    }
    const wtName = name || s.suggestedName;
    // `suggestedBranch` is nullable — a session adopted without a branch carries
    // null, as does one persisted before it was always set — and worktree.create()
    // has no branch name to work from without it. Fall back to the same
    // `feature/<name>` spelling addRepo() uses rather than hand it a null.
    const br = branch || s.suggestedBranch || `feature/${wtName}`;
    const res = await worktree.create(s.repoPath, br, wtName, {
      unique: true, // auto-suffix on collision rather than fail
      layout: this.layout,
      /*
       * Cutting from HEAD is what carries the existing commits: the new branch starts
       * at main's current commit instead of the pushed base. It COPIES rather than
       * moves — the commits stay on `ahead.branch` too, which is deliberate. Rewinding
       * the branch the user is standing on is not something a promote should do behind
       * their back, and duplicate commits merge cleanly anyway.
       */
      ...(bringCommits && ahead.commits.length ? { base: 'HEAD' } : {}),
      ...worktreeCopyOpts(this.cfg, s.repoName),
    });
    if (!res.ok) return res;

    // After the worktree exists, before the session is told about it: a failed replay
    // must not leave a session pointing at a worktree the user has not been told is
    // missing their work.
    let brought: number | undefined;
    if (bringChanges) {
      const moved = await this._moveDirtyInto(s.repoPath, res.path);
      if (!moved.ok) return { ok: false, error: moved.error, worktree: res, path: res.path };
      brought = moved.moved;
    }

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
    if (primary) {
      primary.worktree = res.name;
      primary.worktreePath = res.path;
      primary.branch = res.branch;
    }
    // rename the mux session to the worktree (best-effort; harmless if unsupported)
    const newMux = `wts-${res.name}`.slice(0, 60);
    if (await this.mux.rename(s.muxName, newMux)) s.muxName = newMux;
    // move the running session into the worktree — relocates cwd AND transcript,
    // so resume is seamless from here on (gated on claude being ready)
    await this._anchorInWorktree(s);
    this._touch(id);
    // fan out to any repos chosen up front, serialized (each addRepo is itself gated)
    for (const pr of s.pendingRepos || []) {
      try {
        await this.addRepo(id, pr);
      } catch {
        /* */
      }
    }
    s.pendingRepos = [];
    // Report what actually came along so the toast can say it. Both are undefined when
    // not asked for, which keeps "promoted" the quiet default it was.
    return {
      ok: true,
      session: s,
      worktree: res,
      ...(brought ? { brought } : {}),
      ...(bringCommits && ahead.commits.length ? { broughtCommits: ahead.commits.length } : {}),
    };
  }

  async addTab(id: string, { title, cmd }: { title?: string; cmd?: string } = {}) {
    const s = this.get(id);
    if (!s) return { ok: false, error: 'no such session' };
    const cwd = s.worktreePath || s.repoPath;
    const r = await this.mux.newTab(s.muxName, { title: title || 'shell', cwd, cmd });
    // Only record a tab the multiplexer actually gave us an id for; without one we
    // cannot address it later, and a positional entry is exactly the bug this avoids.
    if (r.ok && r.id) {
      // tmux's `new-window` SELECTS what it creates, so the new tab is the active one and
      // every other is not. Recording that here matters because this branch does not
      // re-sync from the driver — without it the strip would keep pointing at the tab you
      // were on while the terminal showed the new one.
      for (const tab of s.tabs) tab.active = false;
      s.tabs.push({ id: r.id, title: title || 'shell', active: true });
      this._touch(id);
    } else if (r.ok) await this._syncTabs(s);
    return r;
  }

  /** Resolve a tab reference — an id, or a legacy array index — to a live tab. */
  #tabAt(s: Session, ref: string | number): SessionTab | undefined {
    const tabs = s.tabs || [];
    const byId = tabs.find((t) => t.id === String(ref));
    if (byId) return byId;
    const n = Number(ref);
    return Number.isInteger(n) && n >= 0 && n < tabs.length ? tabs[n] : undefined;
  }

  async selectTab(id: string, ref: string | number) {
    const s = this.get(id);
    if (!s) return { ok: false };
    const tab = this.#tabAt(s, ref);
    if (!tab) return { ok: false, error: 'no such tab' };
    const ok = await this.mux.selectTab(s.muxName, tab.id);
    return { ok };
  }

  async renameTab(id: string, ref: string | number, title: string) {
    const s = this.get(id);
    if (!s) return { ok: false, error: 'no such session' };
    const tab = this.#tabAt(s, ref);
    if (!tab) return { ok: false, error: 'no such tab' };
    const clean = String(title || '')
      .trim()
      .slice(0, 40);
    if (!clean) return { ok: false, error: 'a tab needs a name' };
    if (!(await this.mux.renameTab(s.muxName, tab.id, clean))) {
      return { ok: false, error: 'the multiplexer did not rename that tab' };
    }
    tab.title = clean;
    this._touch(id);
    return { ok: true, title: clean };
  }

  async closeTab(id: string, ref: string | number) {
    const s = this.get(id);
    if (!s) return { ok: false };
    if ((s.tabs || []).length <= 1) return { ok: false, error: 'can’t close the only tab' };
    const tab = this.#tabAt(s, ref);
    if (!tab) return { ok: false, error: 'no such tab' };
    // closeTab() returns whether tmux actually killed the window, and that answer was
    // being discarded: a failed kill-window (a stale index, a session tmux no longer
    // has) still spliced the tab out of our list, so the strip claimed a tab was gone
    // while it was still there — and every index after it then pointed at the wrong
    // window. Only mirror a close that happened.
    const ok = await this.mux.closeTab(s.muxName, tab.id);
    if (!ok) return { ok: false, error: 'the multiplexer did not close that tab' };
    // Re-read rather than splice: `renumber-windows on` means every surviving window
    // may have a NEW index now, so the stored ids are stale the instant this returns.
    await this._syncTabs(s);
    this._touch(id);
    return { ok: true };
  }

  async close(id: string, { kill = true }: { kill?: boolean } = {}) {
    const s = this.get(id);
    if (!s) return { ok: false };
    if (kill) await this.mux.kill(s.muxName);
    // clean up the per-session hook settings file (best-effort)
    if (s.settingsFile) {
      try {
        fs.unlinkSync(s.settingsFile);
      } catch {
        /* */
      }
    }
    this.sessions.delete(id);
    this._save();
    this.emit('change', { type: 'session-removed', id });
    return { ok: true };
  }

  // Apply a Claude Code hook event to a session's live state.
  /** @param event    the Claude Code hook name (SessionStart, Stop, …) */
  applyHook(id: string, event: string, payload?: HookBody | null): void {
    const s = this.get(id);
    if (!s) return;
    if (event === 'SessionStart') {
      if (payload?.session_id) s.claudeSessionId = payload.session_id;
      // The seed is delivered as claude's launch arg (see claudeCmd) — nothing to inject.
    }
    const m = status.mapEvent(event, payload);
    if (m) {
      s.state = m.state;
      if (m.activity) s.activity = m.activity;
    }
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

  async rename(id: string, title?: string) {
    const s = this.get(id);
    if (!s || !title?.trim()) return { ok: false, error: 'invalid title' };
    s.title = title.trim();
    this._touch(id);
    return { ok: true };
  }

  // Stop the running process but keep the session (resumable later).
  async deactivate(id: string) {
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
  async activate(id: string) {
    const s = this.get(id);
    if (!s) return { ok: false };
    // A promoted session whose worktree vanished can't continue — flag it instead of
    // faking a resume into a dead directory.
    if (s.worktreePath && !fs.existsSync(s.worktreePath)) {
      s.active = true;
      s.state = 'stopped';
      s.activity = 'worktree missing';
      this._touch(id);
      return { ok: false, error: 'worktree missing' };
    }
    // Regenerate the hook settings file so it tracks the current install path/port —
    // makes a relaunch self-heal after the studio dir is moved or the port changes.
    this._writeHookSettings(s);
    this._shareMemories(s);
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
  async _syncTabs(s: Session): Promise<void> {
    try {
      const live = await this.mux.listTabs(s.muxName);
      if (!live.length) return;
      const prev = s.tabs || [];
      // Match stored titles to live windows BY ID, never by position. tmux renumbers on
      // close, so a positional match relabels the survivors: close the middle of
      // [claude, api, web] and 'api' would land on the window that is now web — a tab
      // naming a terminal that is not the one it selects.
      const byId = new Map(prev.filter((t) => t.id).map((t) => [t.id, t.title]));
      s.tabs = live.map((w) => ({ id: w.id, title: byId.get(w.id) || w.title, active: w.active }));
      // The agent's window is the one the session was launched with, so the first sync —
      // when it is the only window there is — is when its id becomes knowable.
      if (!s.agentTabId && live.length === 1) s.agentTabId = live[0].id;
    } catch {
      /* leave tabs as-is if the mux can't be queried */
    }
  }

  // Self-heal live state against the multiplexer: a session whose tmux session was
  // killed out-of-band (manual `tmux kill-session`, crash) shows a stale live state
  // until an action fails. Flip any such session to stopped. Cheap: one has-session
  // per active session. Already-stopped/deactivated sessions are left untouched, and
  // a query error is treated as "still alive" so we never flip on a transient failure.
  async reconcile(): Promise<void> {
    for (const s of this.sessions.values()) {
      if (!s.muxName || s.active === false || s.state === 'stopped') continue;
      let alive = true;
      try {
        alive = await this.mux.hasSession(s.muxName);
      } catch {
        alive = true;
      }
      if (alive) {
        /*
         * The tmux session is alive — but that stopped meaning the AGENT is, once a
         * session could hold other windows. A run configuration opens a tab in it, so
         * claude can exit while the session lives on in a test tab, and the session then
         * sat at whatever state its last hook reported, glowing "working" forever.
         *
         * Checked by WINDOW ID rather than by what a pane is running: during a Bash tool
         * call claude's pane reports the tool as its foreground command, so "is claude
         * the current command" would call a busy agent dead.
         */
        if (!s.agentTabId) continue; // pre-dates the field — session-level check is all there is
        let windows: string[] = [];
        try {
          windows = (await this.mux.listTabs(s.muxName)).map((w) => w.id);
        } catch {
          continue; // could not ask; say nothing rather than declare it dead
        }
        if (!windows.length || windows.includes(s.agentTabId)) continue;
        s.state = 'stopped';
        s.active = false;
        s.activity = 'agent exited';
        this._touch(s.id);
        continue;
      }
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
  async restore(): Promise<number> {
    let n = 0;
    for (const s of this.all()) {
      if (!s.muxName) continue;
      /*
       * Backfill the agent's window id for sessions that predate the field.
       *
       * A session is launched with exactly one window and Studio titles it `claude`, so
       * a tab still carrying that title is the agent's. Inferred only in the POSITIVE
       * direction: the absence of such a tab is NOT taken to mean the agent is gone,
       * because a renamed tab would then mark a live agent stopped — and Resume on a
       * live agent is worse than a stale badge.
       */
      if (!s.agentTabId) {
        const claudeTab = (s.tabs || []).find((tab) => tab.title === 'claude');
        if (claudeTab?.id) s.agentTabId = claudeTab.id;
      }
      if (s.active === false) continue;
      try {
        if (await this.mux.hasSession(s.muxName)) {
          // No activity string: this is a boot-time fact ("its tmux session outlived the
          // daemon, so we reattached rather than relaunching"), and nothing clears it
          // until the next Claude hook — so it used to sit on every card indefinitely,
          // saying something about the daemon rather than about the session.
          s.activity = '';
          await this._syncTabs(s);
          continue;
        }
        // A promoted session whose worktree is gone can't be resumed meaningfully —
        // flag it rather than launch a dead pane and claim success.
        if (s.worktreePath && !fs.existsSync(s.worktreePath)) {
          s.state = 'stopped';
          s.activity = 'worktree missing';
          continue;
        }
        // Refresh the hook settings file to the current install path/port before relaunch.
        this._writeHookSettings(s);
        this._shareMemories(s);
        const cmd = this.claudeCmd(s, { resume: !!s.claudeSessionId });
        // Resume from the transcript's home dir so --resume finds the conversation.
        // Promoted sessions already have home = worktree (moved at promote time).
        let cwd = s.home || s.repoPath;
        if (!cwd || !fs.existsSync(cwd)) cwd = s.repoPath;
        await this.mux.ensure(s.muxName, { cwd, cmd, env: { WT_STUDIO_SESSION: s.id } });
        // restore recreates only the primary claude window — drop any stale extra
        // tabs so the tab strip matches the windows that actually exist.
        s.tabs = [{ id: PENDING_TAB, title: 'claude' }];
        s.state = 'idle';
        s.activity = s.claudeSessionId ? 'resumed' : 'restarted';
        // self-heal a promote whose /cd never landed (normally a no-op here).
        this._anchorInWorktree(s).catch(() => {});
        n++;
      } catch (e) {
        const msg = (e as Error).message;
        s.state = 'stopped';
        s.activity = `restore failed: ${msg}`;
        console.error(`[wt-studio] could not restore session ${s.id} (${s.title || 'untitled'}): ${msg}`);
      }
    }
    this._save();
    this.emit('change', { type: 'restore', count: n });
    return n;
  }
}

export { SessionManager, deriveBranch, seedPrompt, muxNameFor };
