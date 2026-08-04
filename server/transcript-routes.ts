// HTTP surface for transcript search + token/cost telemetry, plus the wiring that
// keeps the index warm. Everything lives here so server.ts needs exactly one line —
// `require('./transcript-routes').register(api, { manager, cfg })` — which is what
// lets this land alongside an in-flight refactor of server.ts without conflicting.
//
// `api` is the ONE router server.ts mounts at both /api and /api/v1, so every route
// below is reachable under both prefixes without this module naming either of them.
import path from 'path';
import type { Request, Response, Router } from 'express';
import * as transcripts from './transcripts.ts';
import * as pricing from './pricing.ts';
import { STATE_DIR } from './config.ts';
import { TranscriptIndex, summarize } from './transcript-index.ts';
import type { TokenTotals } from './transcripts.ts';
import type { UsageRow, UsageSummary } from './transcript-index.ts';
import type { Config, PartialDeep, Session, SessionState } from './types.ts';

/**
 * The SessionManager, typed by the four members these routes reach for — the same
 * rule server/routes-review.ts and server/orchestrator.ts follow. It is what lets
 * test/api-routing.test.ts mount the whole route table against a three-method fake.
 */
export interface TranscriptManager {
  get(id: string): Session | null | undefined;
  all(): Session[];
  /** Reindex is driven off `hook`; `change` is what forgets a removed session. */
  on(event: 'hook', fn: (e: { id: string; event: string }) => void): unknown;
  on(event: 'change', fn: (c: { type?: string; id?: string } | null) => void): unknown;
}

export interface TranscriptRoutesDeps {
  manager: TranscriptManager;
  /** Only `_stateDir` is read, and it falls back to config.ts's own STATE_DIR. */
  cfg?: PartialDeep<Config> | null;
}

/**
 * One value off a query string. Express hands back a string, an array (`?a=1&a=2`),
 * or a nested object (`?a[b]=1`) — an array or object reaching sqlite or an execFile
 * argv is a TypeError, so nothing below touches `req.query` except through `str()`.
 */
type QueryValue = Request['query'][string];

/** The session identity every transcript response is stamped with. */
interface SessionMeta {
  id: string;
  title: string;
  /**
   * Optional from here down: an ARCHIVED row — a session the index still has telemetry
   * for but which no longer exists — can only honestly report the id and the branch its
   * messages carried. Making these required would force the archive to invent a repo and
   * a state for work that finished.
   */
  feature?: string;
  branch?: string | null;
  repo?: string;
  active?: boolean;
  state?: SessionState;
}

/** One session's telemetry row in the fleet-wide rollup. */
type SessionUsage = UsageSummary & { session: SessionMeta; indexed: boolean; archived?: boolean };

/** A feature's rollup, accumulated across its sessions before pricing is rounded. */
interface FeatureUsage extends TokenTotals {
  feature: string;
  sessions: number;
  costUsd: number;
  unpricedModels: Set<string>;
}

// What every cost-bearing response says about where its dollars came from.
//
// `cacheMultipliers` is here because the client cannot derive it and used to hardcode
// a copy (client/src/lib/components/insights/format.js). The API prices a MODEL, never
// a token class, so a UI that wants to show "which token class cost the money" has to
// know that cache classes bill as fixed multiples of the model's input rate. When those
// multiples changed, the server's dollars moved and the client's billed-weight chart
// silently kept the old ratios — the same screen then answered "where did the money go"
// two different ways. Publishing them makes server/pricing.ts the single source.
function pricingBlock() {
  return {
    verifiedAt: pricing.PRICING_VERIFIED,
    note: pricing.ESTIMATE_NOTE,
    // Multiples of the model's INPUT rate. `input: 1` is stated rather than implied so
    // a client can consume the map wholesale instead of special-casing one member.
    cacheMultipliers: {
      input: 1,
      cacheWrite5m: pricing.CACHE_WRITE_5M,
      cacheWrite1h: pricing.CACHE_WRITE_1H,
      cacheRead: pricing.CACHE_READ,
    },
  };
}

function register(api: Router, deps: TranscriptRoutesDeps): { index: TranscriptIndex; router: Router } {
  const { manager, cfg } = deps || {};
  if (!api || !manager) throw new Error('transcript-routes.register needs { manager }');

  // config.ts owns where state lives (and honors WT_STUDIO_STATE); `cfg._stateDir` is
  // that same value riding on the loaded config. Falling back to a path spelled here
  // is how the index ended up under a `~/.wt-studio` that exists nowhere else.
  const stateDir = cfg?._stateDir || STATE_DIR;
  const index = new TranscriptIndex({ file: path.join(stateDir, 'transcripts.db') });
  if (!index.ready)
    console.warn(
      `[wt-studio] transcript index unavailable (${index.error}) — search falls back to file scan`,
    );

  // ---- keeping the index warm ----
  // The Stop hook is the natural trigger: it fires exactly when claude has finished
  // writing a turn, so the appended bytes are complete and there is nothing to index
  // between turns. Indexing on every hook event would re-stat the file per tool call
  // for no gain.
  const REINDEX_ON = new Set(['Stop', 'SubagentStop', 'SessionEnd']);
  // A Set of session ids, not an array of jobs: a session that fires Stop three times
  // while the drain is busy needs ONE more pass, not three. Indexing is incremental
  // and idempotent, so the extra passes were pure re-stat work — and a burst of
  // subagent Stops (one per parallel agent) is the normal case, not the rare one.
  // The id is the key rather than the session object because the object identity a
  // hook hands us is not guaranteed to be the same one the next hook does.
  const queue = new Set<string>();
  let draining = false;

  function enqueue(session: Session | null | undefined): void {
    if (!session?.id || !index.ready) return;
    queue.add(session.id);
    if (!draining) drain();
  }

  async function drain(): Promise<void> {
    draining = true;
    while (queue.size) {
      const id = queue.values().next().value;
      if (id === undefined) break; // size > 0 guarantees one, but the iterator says `| undefined`
      queue.delete(id); // delete BEFORE indexing, so a Stop arriving mid-pass re-queues
      const session = manager.get(id);
      if (!session) continue;
      try {
        await index.index(session);
      } catch (e) {
        console.error('[wt-studio] index', e instanceof Error ? e.message : e);
      }
    }
    draining = false;
  }

  manager.on('hook', ({ id, event }: { id: string; event: string }) => {
    if (!REINDEX_ON.has(event)) return;
    enqueue(manager.get(id));
  });
  /*
   * A removed session KEEPS its telemetry.
   *
   * This used to call index.forget(id), which deletes the session's messages, usage and
   * file rows. That made cost history a property of the live session list: delete a
   * worktree and what it cost you was gone. Telemetry is the record of work that already
   * happened — it should outlive the worktree, which is the whole reason to look at it
   * afterwards. The index is an archive now, and /transcripts/usage renders rows with no
   * live session as archived. index.forget() stays for a real purge.
   */

  // Catch up on everything already on disk, once, off the boot path.
  setTimeout(() => {
    for (const s of manager.all()) enqueue(s);
  }, 2000).unref?.();

  // Bring one session up to date before answering a query about it, so a caller
  // never sees stale numbers just because no Stop hook has fired since the last turn.
  async function fresh(session: Session): Promise<void> {
    if (!index.ready) return;
    try {
      await index.index(session);
    } catch {
      /* fall through to whatever is indexed */
    }
  }

  function need(req: Request<{ id: string }>, res: Response): Session | null {
    const s = manager.get(req.params.id);
    if (!s) {
      res.status(404).json({ error: 'no such session' });
      return null;
    }
    return s;
  }

  const meta = (s: Session): SessionMeta => ({
    id: s.id,
    title: s.title,
    feature: s.feature,
    branch: s.branch,
    repo: s.repoName,
    active: s.active,
    state: s.state,
  });

  // A query param arrives as a STRING, an ARRAY (`?role=a&role=b`) or undefined, and
  // an array reaching sqlite or an execFile argv is a TypeError — a 500 leaking an
  // internal message where the request was simply malformed. Collapse to the first
  // value, which is what a client sending one of something meant.
  const one = (v: QueryValue): QueryValue => (Array.isArray(v) ? v[0] : v);
  function str(v: QueryValue, fallback: string): string;
  function str(v: QueryValue, fallback?: null): string | null;
  function str(v: QueryValue, fallback: string | null = null): string | null {
    const x = one(v);
    return x === undefined || x === null ? fallback : String(x);
  }

  const r = api;

  r.get('/transcripts/status', async (_req, res) => {
    res.json({ ...index.status(), pricing: pricingBlock() });
  });

  // Which transcript a session maps to, and whether we can see it. Useful on its own
  // when a session's numbers look empty — it says WHY.
  r.get('/sessions/:id/transcript', async (req, res) => {
    const s = need(req, res);
    if (!s) return;
    const loc = transcripts.locate(s, {});
    res.json({
      session: meta(s),
      claudeSessionId: s.claudeSessionId,
      ...loc,
      projectsRoot: transcripts.projectsRoot({}),
    });
  });

  // ---- search ----
  r.get('/transcripts/search', async (req, res) => {
    const q = str(req.query.q, null) ?? str(req.query.query, '');
    if (!q.trim()) return res.json({ query: '', hits: [], total: 0, backend: index.status().backend });
    const sessionId = str(req.query.session, null) ?? str(req.query.sessionId, null);
    if (sessionId) {
      const s = manager.get(sessionId);
      if (s) await fresh(s);
    }

    if (!index.ready) {
      // No sqlite → scan the files we know about directly. Bounded by session count,
      // which is small by construction.
      const hits = [];
      const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 30));
      for (const s of manager.all()) {
        if (sessionId && s.id !== sessionId) continue;
        const loc = transcripts.locate(s, {});
        if (!loc.found) continue;
        for (const h of await transcripts.search(loc.file, { query: q, limit: limit - hits.length })) {
          hits.push({ ...h, sessionId: s.id, session: meta(s) });
        }
        if (hits.length >= limit) break;
      }
      return res.json({ query: q, backend: 'file-scan', hits, total: hits.length });
    }

    const out = index.search(q, {
      sessionId,
      role: str(req.query.role, null),
      since: req.query.since ? Number(str(req.query.since)) : null,
      order: str(req.query.order, 'rank'),
      limit: str(req.query.limit),
    });
    // Decorate rather than mutate: `IndexSearchHit` is what the index returns and
    // stamping the session onto it is this route's addition, not the index's.
    const hits = out.hits.map((h) => {
      const s = manager.get(h.sessionId);
      return s ? { ...h, session: meta(s) } : h;
    });
    res.json({ ...out, hits });
  });

  r.get('/sessions/:id/transcript/search', async (req, res) => {
    const s = need(req, res);
    if (!s) return;
    await fresh(s);
    const q = str(req.query.q, null) ?? str(req.query.query, '');
    if (!index.ready) {
      const loc = transcripts.locate(s, {});
      if (!loc.found)
        return res.json({ query: q, backend: 'file-scan', hits: [], total: 0, reason: loc.reason });
      const hits = await transcripts.search(loc.file, {
        query: q,
        limit: Number(str(req.query.limit)) || 30,
      });
      return res.json({ query: q, backend: 'file-scan', session: meta(s), hits, total: hits.length });
    }
    res.json({
      ...index.search(q, {
        sessionId: s.id,
        limit: str(req.query.limit),
        order: str(req.query.order, 'rank'),
      }),
      session: meta(s),
    });
  });

  // ---- telemetry ----
  // Carries the same `pricing` block as the fleet endpoint: a client that mounts one
  // session's telemetry on its own must still learn the cache multipliers, or its
  // billed-weight chart falls back to whatever it last knew.
  r.get('/sessions/:id/transcript/usage', async (req, res) => {
    const s = need(req, res);
    if (!s) return;
    await fresh(s);
    if (index.ready) {
      const rows = index.usageRows(s.id);
      if (rows.length)
        return res.json({
          session: meta(s),
          source: 'index',
          ...summarize(rows),
          costIsEstimate: true,
          pricing: pricingBlock(),
        });
    }
    // Not indexed (or no sqlite) → read the transcript directly.
    const loc = transcripts.locate(s, {});
    if (!loc.found)
      return res.json({
        session: meta(s),
        source: 'none',
        reason: loc.reason,
        ...summarize([]),
        pricing: pricingBlock(),
      });
    const agg = await transcripts.aggregate(loc.file);
    res.json({ session: meta(s), source: 'transcript', ...agg, pricing: pricingBlock() });
  });

  // Everything at once: per session, rolled up per feature, plus a grand total.
  // Feature is the identity that ties a feature's worktrees together across repos,
  // so it is the unit worth costing.
  r.get('/transcripts/usage', async (req, res) => {
    const sessions = manager.all();
    if (req.query.refresh === '1') {
      for (const s of sessions) await fresh(s);
    }

    const bySession = new Map<string, UsageRow[]>();
    if (index.ready) {
      for (const row of index.usageRows(null)) {
        let rows = bySession.get(row.session_id);
        if (!rows) {
          rows = [];
          bySession.set(row.session_id, rows);
        }
        rows.push(row);
      }
    }

    /*
     * The INDEX is the outer loop, not the live session list.
     *
     * Iterating `sessions` meant a session's spend vanished from this view the moment
     * the session was deleted, even with its rows on disk — you could not ask what last
     * month's finished work had cost. Every indexed session appears; one with no live
     * counterpart is reported as archived, carrying the identity the index recorded.
     * Live sessions with no rows yet still appear (indexed: false), as before.
     */
    const live = new Map(sessions.map((s) => [s.id, s]));
    const ids = new Set<string>([...live.keys(), ...bySession.keys()]);

    const out: SessionUsage[] = [];
    for (const id of ids) {
      const s = live.get(id);
      const rows = bySession.get(id) || [];
      if (!s && !rows.length) continue;
      out.push({
        session: s ? meta(s) : index.archivedMeta(id),
        ...summarize(rows),
        indexed: rows.length > 0,
        archived: !s,
      });
    }

    const features = new Map<string, FeatureUsage>();
    for (const e of out) {
      const key = e.session.feature || e.session.id;
      let f = features.get(key);
      if (!f) {
        f = {
          feature: key,
          sessions: 0,
          ...transcripts.blankTotals(),
          costUsd: 0,
          unpricedModels: new Set<string>(),
        };
        features.set(key, f);
      }
      f.sessions++;
      transcripts.addUsage(f, e);
      f.costUsd += e.costUsd || 0;
      for (const m of e.unpricedModels) f.unpricedModels.add(m);
    }

    const totals = transcripts.blankTotals();
    let costUsd = 0;
    const unpriced = new Set<string>();
    for (const e of out) {
      transcripts.addUsage(totals, e);
      costUsd += e.costUsd || 0;
      for (const m of e.unpricedModels) unpriced.add(m);
    }

    res.json({
      sessions: out.sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0)),
      features: [...features.values()]
        .map((f) => ({ ...f, costUsd: pricing.round(f.costUsd), unpricedModels: [...f.unpricedModels] }))
        .sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0)),
      totals: { ...totals, costUsd: pricing.round(costUsd), unpricedModels: [...unpriced] },
      costIsEstimate: true,
      pricing: pricingBlock(),
      backend: index.status().backend,
    });
  });

  r.post('/transcripts/reindex', async (req, res) => {
    const body: { full?: unknown; session?: unknown } =
      req.body && typeof req.body === 'object' ? req.body : {};
    const full = body.full === true || req.query.full === '1';
    const only = body.session ? manager.get(String(body.session)) : null;
    const targets: Session[] = body.session ? (only ? [only] : []) : manager.all();
    const results = [];
    for (const s of targets) results.push({ session: s.id, ...(await index.index(s, { full })) });
    res.json({ ok: true, full, results, status: index.status() });
  });

  return { index, router: r };
}

export { register };
