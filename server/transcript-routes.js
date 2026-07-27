'use strict';
// HTTP surface for transcript search + token/cost telemetry, plus the wiring that
// keeps the index warm. Everything lives here so server.js needs exactly one line —
// `require('./transcript-routes').register(app, { manager, cfg })` — which is what
// lets this land alongside an in-flight refactor of server.js without conflicting.
const express = require('express');
const path = require('path');
const transcripts = require('./transcripts');
const pricing = require('./pricing');
const { TranscriptIndex, summarize } = require('./transcript-index');

// Same contract as server.js's A(): a rejected handler becomes a 500 instead of an
// unhandled rejection (Express 4 doesn't await handlers).
const A = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error('[wt-studio] transcripts', e);
  if (!res.headersSent) res.status(500).json({ error: e.message });
});

function register(app, deps = {}) {
  const { manager, cfg } = deps;
  if (!app || !manager) throw new Error('transcript-routes.register needs { manager }');

  const stateDir = (cfg && cfg._stateDir) || path.join(require('os').homedir(), '.wt-studio');
  const index = new TranscriptIndex({ file: path.join(stateDir, 'transcripts.db') });
  if (!index.ready) console.warn(`[wt-studio] transcript index unavailable (${index.error}) — search falls back to file scan`);

  // ---- keeping the index warm ----
  // The Stop hook is the natural trigger: it fires exactly when claude has finished
  // writing a turn, so the appended bytes are complete and there is nothing to index
  // between turns. Indexing on every hook event would re-stat the file per tool call
  // for no gain.
  const REINDEX_ON = new Set(['Stop', 'SubagentStop', 'SessionEnd']);
  const queue = [];
  let draining = false;

  function enqueue(session, opts) {
    if (!session || !index.ready) return;
    queue.push([session, opts || {}]);
    if (!draining) drain();
  }

  async function drain() {
    draining = true;
    while (queue.length) {
      const [session, opts] = queue.shift();
      try { await index.index(session, opts); } catch (e) { console.error('[wt-studio] index', e.message); }
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

  const r = express.Router();

  r.get('/transcripts/status', A(async (req, res) => {
    res.json({ ...index.status(), pricing: { verifiedAt: pricing.PRICING_VERIFIED, note: pricing.ESTIMATE_NOTE } });
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
    const q = req.query.q || req.query.query || '';
    if (!String(q).trim()) return res.json({ query: '', hits: [], total: 0, backend: index.status().backend });
    const sessionId = req.query.session || req.query.sessionId || null;
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
      role: req.query.role || null,
      since: req.query.since ? Number(req.query.since) : null,
      order: req.query.order || 'rank',
      limit: req.query.limit,
    });
    for (const h of out.hits) { const s = manager.get(h.sessionId); if (s) h.session = meta(s); }
    res.json(out);
  }));

  r.get('/sessions/:id/transcript/search', A(async (req, res) => {
    const s = need(req, res); if (!s) return;
    await fresh(s);
    const q = req.query.q || req.query.query || '';
    if (!index.ready) {
      const loc = transcripts.locate(s, {});
      if (!loc.found) return res.json({ query: q, backend: 'file-scan', hits: [], total: 0, reason: loc.reason });
      const hits = await transcripts.search(loc.file, { query: q, limit: Number(req.query.limit) || 30 });
      return res.json({ query: q, backend: 'file-scan', session: meta(s), hits, total: hits.length });
    }
    res.json({ ...index.search(q, { sessionId: s.id, limit: req.query.limit, order: req.query.order || 'rank' }), session: meta(s) });
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
      pricing: { verifiedAt: pricing.PRICING_VERIFIED, note: pricing.ESTIMATE_NOTE },
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

  // Mount versioned and unversioned. Both paths are the same router, so they can
  // never drift apart.
  app.use('/api/v1', r);
  app.use('/api', r);

  return { index, router: r };
}

module.exports = { register };
