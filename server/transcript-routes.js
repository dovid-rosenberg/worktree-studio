'use strict';
// HTTP surface for transcript search + token/cost telemetry, plus the wiring that
// keeps the index warm. Everything lives here so server.js needs exactly one line —
// `require('./transcript-routes').register(api, { manager, cfg })` — which is what
// lets this land alongside an in-flight refactor of server.js without conflicting.
//
// `api` is the ONE router server.js mounts at both /api and /api/v1, so every route
// below is reachable under both prefixes without this module naming either of them.
const path = require('path');
const transcripts = require('./transcripts');
const pricing = require('./pricing');
const { STATE_DIR } = require('./config');
const { taggedA } = require('./util');
const { TranscriptIndex, summarize } = require('./transcript-index');

// The shared wrapper (server/util.js), tagged so a transcript route's 500 is
// identifiable in a log full of route failures.
const A = taggedA('transcripts');

// What every cost-bearing response says about where its dollars came from.
//
// `cacheMultipliers` is here because the client cannot derive it and used to hardcode
// a copy (client/src/lib/components/insights/format.js). The API prices a MODEL, never
// a token class, so a UI that wants to show "which token class cost the money" has to
// know that cache classes bill as fixed multiples of the model's input rate. When those
// multiples changed, the server's dollars moved and the client's billed-weight chart
// silently kept the old ratios — the same screen then answered "where did the money go"
// two different ways. Publishing them makes server/pricing.js the single source.
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

function register(api, deps = {}) {
  const { manager, cfg } = deps;
  if (!api || !manager) throw new Error('transcript-routes.register needs { manager }');

  // config.js owns where state lives (and honors WT_STUDIO_STATE); `cfg._stateDir` is
  // that same value riding on the loaded config. Falling back to a path spelled here
  // is how the index ended up under a `~/.wt-studio` that exists nowhere else.
  const stateDir = (cfg && cfg._stateDir) || STATE_DIR;
  const index = new TranscriptIndex({ file: path.join(stateDir, 'transcripts.db') });
  if (!index.ready) console.warn(`[wt-studio] transcript index unavailable (${index.error}) — search falls back to file scan`);

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
  const queue = new Set();
  let draining = false;

  function enqueue(session) {
    if (!session || !session.id || !index.ready) return;
    queue.add(session.id);
    if (!draining) drain();
  }

  async function drain() {
    draining = true;
    while (queue.size) {
      const id = queue.values().next().value;
      queue.delete(id); // delete BEFORE indexing, so a Stop arriving mid-pass re-queues
      const session = manager.get(id);
      if (!session) continue;
      try { await index.index(session); } catch (e) { console.error('[wt-studio] index', e.message); }
    }
    draining = false;
  }

  manager.on('hook', ({ id, event }) => {
    if (!REINDEX_ON.has(event)) return;
    enqueue(manager.get(id));
  });
  manager.on('change', (c) => { if (c && c.type === 'session-removed' && c.id) index.forget(c.id); });

  // Catch up on everything already on disk, once, off the boot path.
  setTimeout(() => { for (const s of manager.all()) enqueue(s); }, 2000).unref?.();

  // Bring one session up to date before answering a query about it, so a caller
  // never sees stale numbers just because no Stop hook has fired since the last turn.
  async function fresh(session) {
    if (!index.ready) return;
    try { await index.index(session); } catch { /* fall through to whatever is indexed */ }
  }

  function need(req, res) {
    const s = manager.get(req.params.id);
    if (!s) { res.status(404).json({ error: 'no such session' }); return null; }
    return s;
  }

  const meta = (s) => ({ id: s.id, title: s.title, feature: s.feature, branch: s.branch, repo: s.repoName, active: s.active, state: s.state });

  // A query param arrives as a STRING, an ARRAY (`?role=a&role=b`) or undefined, and
  // an array reaching sqlite or an execFile argv is a TypeError — a 500 leaking an
  // internal message where the request was simply malformed. Collapse to the first
  // value, which is what a client sending one of something meant.
  const one = (v) => (Array.isArray(v) ? v[0] : v);
  const str = (v, fallback = null) => { const x = one(v); return x === undefined || x === null ? fallback : String(x); };

  const r = api;

  r.get('/transcripts/status', A(async (req, res) => {
    res.json({ ...index.status(), pricing: pricingBlock() });
  }));

  // Which transcript a session maps to, and whether we can see it. Useful on its own
  // when a session's numbers look empty — it says WHY.
  r.get('/sessions/:id/transcript', A(async (req, res) => {
    const s = need(req, res); if (!s) return;
    const loc = transcripts.locate(s, {});
    res.json({ session: meta(s), claudeSessionId: s.claudeSessionId, ...loc, projectsRoot: transcripts.projectsRoot({}) });
  }));

  // ---- search ----
  r.get('/transcripts/search', A(async (req, res) => {
    const q = str(req.query.q, null) ?? str(req.query.query, '');
    if (!q.trim()) return res.json({ query: '', hits: [], total: 0, backend: index.status().backend });
    const sessionId = str(req.query.session, null) ?? str(req.query.sessionId, null);
    if (sessionId) { const s = manager.get(sessionId); if (s) await fresh(s); }

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
      since: req.query.since ? Number(one(req.query.since)) : null,
      order: str(req.query.order, 'rank'),
      limit: one(req.query.limit),
    });
    for (const h of out.hits) { const s = manager.get(h.sessionId); if (s) h.session = meta(s); }
    res.json(out);
  }));

  r.get('/sessions/:id/transcript/search', A(async (req, res) => {
    const s = need(req, res); if (!s) return;
    await fresh(s);
    const q = str(req.query.q, null) ?? str(req.query.query, '');
    if (!index.ready) {
      const loc = transcripts.locate(s, {});
      if (!loc.found) return res.json({ query: q, backend: 'file-scan', hits: [], total: 0, reason: loc.reason });
      const hits = await transcripts.search(loc.file, { query: q, limit: Number(one(req.query.limit)) || 30 });
      return res.json({ query: q, backend: 'file-scan', session: meta(s), hits, total: hits.length });
    }
    res.json({ ...index.search(q, { sessionId: s.id, limit: one(req.query.limit), order: str(req.query.order, 'rank') }), session: meta(s) });
  }));

  // ---- telemetry ----
  r.get('/sessions/:id/transcript/usage', A(async (req, res) => {
    const s = need(req, res); if (!s) return;
    await fresh(s);
    if (index.ready) {
      const rows = index.usageRows(s.id);
      if (rows.length) return res.json({ session: meta(s), source: 'index', ...summarize(rows), costIsEstimate: true });
    }
    // Not indexed (or no sqlite) → read the transcript directly.
    const loc = transcripts.locate(s, {});
    if (!loc.found) return res.json({ session: meta(s), source: 'none', reason: loc.reason, ...summarize([]) });
    const agg = await transcripts.aggregate(loc.file);
    res.json({ session: meta(s), source: 'transcript', ...agg });
  }));

  // Everything at once: per session, rolled up per feature, plus a grand total.
  // Feature is the identity that ties a feature's worktrees together across repos,
  // so it is the unit worth costing.
  r.get('/transcripts/usage', A(async (req, res) => {
    const sessions = manager.all();
    if (req.query.refresh === '1') { for (const s of sessions) await fresh(s); }

    const bySession = new Map();
    if (index.ready) {
      for (const row of index.usageRows(null)) {
        if (!bySession.has(row.session_id)) bySession.set(row.session_id, []);
        bySession.get(row.session_id).push(row);
      }
    }

    const out = [];
    for (const s of sessions) {
      const rows = bySession.get(s.id) || [];
      out.push({ session: meta(s), ...summarize(rows), indexed: rows.length > 0 });
    }

    const features = new Map();
    for (const e of out) {
      const key = e.session.feature || e.session.id;
      if (!features.has(key)) features.set(key, { feature: key, sessions: 0, ...transcripts.blankTotals(), costUsd: 0, unpricedModels: new Set() });
      const f = features.get(key);
      f.sessions++;
      transcripts.addUsage(f, e);
      f.costUsd += e.costUsd || 0;
      for (const m of e.unpricedModels) f.unpricedModels.add(m);
    }

    const totals = transcripts.blankTotals();
    let costUsd = 0;
    const unpriced = new Set();
    for (const e of out) { transcripts.addUsage(totals, e); costUsd += e.costUsd || 0; for (const m of e.unpricedModels) unpriced.add(m); }

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
  }));

  r.post('/transcripts/reindex', A(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const full = body.full === true || req.query.full === '1';
    const targets = body.session ? [manager.get(body.session)].filter(Boolean) : manager.all();
    const results = [];
    for (const s of targets) results.push({ session: s.id, ...(await index.index(s, { full })) });
    res.json({ ok: true, full, results, status: index.status() });
  }));

  return { index, router: r };
}

module.exports = { register };
