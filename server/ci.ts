// PR/CI status as pushed state.
//
// It used to be polled twice over. The browser re-fetched GET /sessions/:id/ci
// every 30 s for whichever session happened to be selected, and server/forge.ts
// cached each gh/glab lookup for 20 s so that polling could not hammer the CLIs —
// two layers of polling compensating for each other, both running whether or not
// the answer had changed, and neither able to tell the user anything sooner than
// the next tick. This module replaces the client's half with the same push model
// the rest of the state uses. It owns three things:
//
//   * the snapshot — sessionId → the `repos` array GET /sessions/:id/ci returns;
//   * when to rebuild it — on the events that plausibly change CI, plus one slow
//     safety net for the changes that happen entirely on the forge's side;
//   * whether to rebuild it at all — nothing here spawns a process unless somebody
//     is subscribed to the SSE stream.
//
// --- why its own `ci` event, not the session-state half ----------------------
// session-state is the hook half: it is re-sent on every Claude Code hook, i.e.
// every tool call, many times a second in an active session. CI status changes on
// the order of minutes. Folding the snapshot in would re-serialize an unchanged
// payload thousands of times an hour, and — the part that actually matters — would
// put a slow, hang-prone `gh`/`glab` lookup somewhere on the path of the hottest
// broadcast in the server. As its own event the snapshot is built off to the side,
// emitted only when it differs, and a wedged CLI is visible as nothing more than a
// pill that stops updating.
//
// --- why the gate is "an SSE client is attached" -----------------------------
// A `ci` frame can only be delivered to a subscriber. SwiftBar and Alfred never
// subscribe — they poll /state and, for CI, ask GET /sessions/:id/ci directly and
// get an on-demand answer — so counting their polls as attention would spawn `gh`
// for an audience that will never receive the result. That is exactly
// watch.ts's attention({ streams }) with its poll arm left dormant (`seen()` is
// never called), which is what this uses: one helper, one meaning of "someone is
// looking", two different definitions of "someone".
//
// --- what a sweep may cost ---------------------------------------------------
// A sweep looks up every promoted (worktree + branch) pair across every session,
// deduplicated — two sessions on one worktree, or a repo listed twice, cost one
// lookup — a few at a time, because each is a process. `minSweepMs` is pinned to
// forge's cache TTL, so however many triggers arrive, no worktree+branch pair can
// be looked up more often than the 20 s cache already allowed. With nobody
// subscribed the figure is zero.
import { attention } from './watch.ts';
import type { CiEntry } from './forge.ts';
import type { CiPayload, CiRepo, CiSnapshot } from './types.ts';

const DEFAULTS = {
  debounceMs: 500,       // coalesce a burst of triggers (a rescan storm, push then commit) into one sweep
  minSweepMs: 20000,     // floor between sweeps — forge's CI_TTL, i.e. never more often than polling was
  netMs: 90000,          // safety net while somebody is watching: a queued check going green has no local signal
  tickMs: 5000,          // heartbeat that decides whether the net is due; spawns nothing itself
  concurrency: 4,        // parallel gh/glab processes at most
  sweepTimeoutMs: 45000, // a sweep that hasn't finished by now is abandoned so the next one can run
};

function unref<T extends { unref?: () => unknown }>(t: T): T { if (t && typeof t.unref === 'function') t.unref(); return t; }

// Run `fn` over `items` with at most `limit` in flight. Order is irrelevant here —
// every result is keyed — so this is a pool of workers pulling from one cursor.
async function pool<T>(items: T[], limit: number, fn: (item: T) => unknown): Promise<void> {
  let i = 0;
  const worker = async () => { while (i < items.length) { const n = i++; await fn(items[n]); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

/**
 * createForge()'s result, typed by the two methods the feed actually reaches for,
 * not by the whole object: that IS the dependency, and a test double owes nothing
 * more.
 */
interface CiForge {
  ciForRepo: (entry: CiEntry) => Promise<CiRepo>;
  invalidate?: () => void;
}

/**
 * A session, as the sweep reads it: an id to key the snapshot by, and the repos it
 * may have promoted. `types.ts`'s `Session` satisfies it.
 */
interface CiSession {
  id: string;
  repos?: CiEntry[] | null;
}

interface CiFeedDeps {
  forge: CiForge;
  /** () → the current session list (manager.all()) */
  sessions?: () => CiSession[];
  /**
   * () → open SSE stream count; the attention signal. Omitted, nothing ever sweeps —
   * this fails closed, because a half-wired feed spawning `gh` for nobody is the one
   * outcome worth ruling out by construction.
   */
  streams?: () => number;
  /** called when the snapshot differs from the last one */
  onChange?: (snapshot: CiSnapshot) => void;
  /** DEFAULTS overrides — the tests run the same code paths on a millisecond timescale */
  intervals?: Partial<typeof DEFAULTS>;
}

interface PokeOptions {
  /**
   * the caller knows the truth changed (a commit, a push, a PR just opened), so the
   * cached answer is wrong rather than merely old and has to be dropped.
   */
  force?: boolean;
}

function createCiFeed({ forge, sessions, streams, onChange = () => {}, intervals }: CiFeedDeps) {
  const o = { ...DEFAULTS, ...(intervals || {}) };
  // The poll arm is deliberately never fed (`seen()` is not called): for CI,
  // "someone is looking" means an open stream and nothing else. See above.
  const watching = attention({ streams });

  let snapshot: CiSnapshot = {};
  let sig = '{}';
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;
  let queued = false;
  let gen = 0;
  let lastSweepAt = 0;
  let sweeps = 0;
  let lookups = 0;

  // Every distinct worktree+branch a session owns, keyed exactly as forge's cache
  // keys it. One entry per pair: the map collapses the duplicates before they can
  // become processes.
  function entries(list: CiSession[] | null | undefined): Map<string, CiEntry> {
    const out = new Map<string, CiEntry>();
    for (const s of (list || [])) {
      for (const r of (s.repos || [])) {
        if (r && r.worktreePath && r.branch) out.set(`${r.worktreePath}\n${r.branch}`, r);
      }
    }
    return out;
  }

  // Rebuild the snapshot. Never throws: forge.ciForRepo already answers
  // { repo, hasPR:false } for every failure mode (no CLI, not authenticated, no
  // remote, no PR, a CLI that blew up), and the guard here covers the rest so a
  // sweep can never reject into the caller or the bus.
  async function sweep(my: number): Promise<void> {
    const list = sessions ? sessions() : [];
    const wanted = entries(list);
    const results = new Map<string, CiRepo>();
    await pool([...wanted], o.concurrency, async ([key, entry]) => {
      lookups += 1;
      try { results.set(key, await forge.ciForRepo(entry)); }
      catch { results.set(key, { repo: entry.repo, hasPR: false }); }
    });
    if (stopped || my !== gen) return; // abandoned mid-flight — a newer sweep owns the snapshot

    const next: CiSnapshot = {};
    for (const s of list) {
      const repos: CiRepo[] = [];
      for (const r of (s.repos || [])) {
        if (!r || !r.worktreePath || !r.branch) continue;
        const found = results.get(`${r.worktreePath}\n${r.branch}`);
        repos.push(found ? { ...found, repo: r.repo } : { repo: r.repo, hasPR: false });
      }
      if (repos.length) next[s.id] = repos; // an unpromoted session has no CI half at all
    }

    const nextSig = JSON.stringify(next);
    if (nextSig === sig) return; // nothing moved — do not wake every subscriber up
    sig = nextSig;
    snapshot = next;
    try { onChange(snapshot); } catch { /* a broken listener must not kill the feed */ }
  }

  function runSweep(): void {
    if (stopped) return;
    if (busy) { queued = true; return; }
    busy = true;
    sweeps += 1;
    const my = ++gen;
    const release = () => {
      if (my !== gen) return; // a later sweep already took over
      busy = false;
      lastSweepAt = Date.now();
      if (queued) { queued = false; poke(); }
    };
    // A gh/glab that never returns must not wedge the feed forever. forge kills the
    // child on its own timeout; this covers the case where even that doesn't land,
    // by giving up on the result and letting the next trigger start clean.
    const guard = unref(setTimeout(() => { gen += 1; busy = false; lastSweepAt = Date.now(); }, o.sweepTimeoutMs));
    Promise.resolve()
      .then(() => sweep(my))
      .catch(() => { /* sweep is already total; this is the belt to its braces */ })
      .then(() => { clearTimeout(guard); release(); });
  }

  /**
   * "Something happened that may have changed CI." Debounced, floored at
   * minSweepMs, and a no-op when nobody is subscribed — the timer is not even
   * armed then, so an idle server with a busy git repo stays silent.
   */
  function poke({ force = false }: PokeOptions = {}): void {
    if (stopped || !watching.active()) return;
    if (force && forge && typeof forge.invalidate === 'function') forge.invalidate();
    if (timer) return;
    const wait = Math.max(o.debounceMs, o.minSweepMs - (Date.now() - lastSweepAt));
    timer = unref(setTimeout(() => { timer = null; runSweep(); }, wait));
  }

  // The safety net. CI moves on the forge's side — a queued check goes green with no
  // local event of any kind — so triggers alone would leave a running pill running
  // forever. The heartbeat itself spawns nothing, which is why it can afford to be
  // frequent: it only asks whether the net is due, and only while someone is watching.
  const tick = () => {
    if (stopped || busy || !watching.active()) return;
    if (Date.now() - lastSweepAt >= o.netMs) runSweep();
  };
  const heartbeat = unref(setInterval(tick, o.tickMs));

  return {
    poke,
    // The `ci` half as the bus serializes it. A getter, not a value: the bus reads
    // it at write time, so a subscriber and a flush can never disagree.
    snapshot(): CiPayload { return { ci: snapshot }; },
    stop(): void {
      stopped = true;
      clearInterval(heartbeat);
      if (timer) clearTimeout(timer);
      timer = null;
    },
    stats() { return { sweeps, lookups, watching: watching.active() }; },
  };
}

export { createCiFeed, DEFAULTS };
