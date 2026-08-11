// The intake sources' HTTP surface: which ones are usable, what one of them has to
// offer, and proving a token before anything is saved.
//
// Thin on purpose — server/sources/index.ts already owns the "is this adapter enabled,
// and what did it answer" decision, and every adapter is reachable only through it (see
// adapterFor: an own-key lookup, so `/sources/constructor/items` is a refusal rather
// than a 500).
//
// `api` is the ONE router server.ts mounts at both /api and /api/v1 — see
// server/routes-review.ts for why registering onto it is what makes the two prefixes
// answer identically.
import type { Router } from 'express';
import * as asana from './sources/asana.ts';
import * as sources from './sources/index.ts';
import type { Config, PartialDeep } from './types.ts';

/** A thrown value's message. `catch` binds `unknown`, and not everything thrown is an Error. */
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface SourcesDeps {
  cfg: PartialDeep<Config>;
  /** The scan cache, for the `?repo=` a repo-scoped source needs a path for. */
  repos: () => Array<{ name: string; path: string }>;
}

function register(api: Router, { cfg, repos }: SourcesDeps): void {
  api.get('/sources', (_req, res) => res.json(sources.enabled(cfg)));

  /*
   * Check a token the user has just typed, and report who it belongs to.
   *
   * Takes the token in the BODY rather than reading config, because it is asked BEFORE
   * anything is saved — proving the token works is what the user is doing when they press
   * Connect. Nothing is persisted here.
   */
  api.post('/sources/asana/verify', async (req, res) => {
    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ ok: false, error: 'a token is required' });
    try {
      res.json({ ok: true, ...(await asana.verify(token)) });
    } catch (e) {
      // Asana answers 401 for a bad token, which is much the commonest thing to get wrong.
      const m = msg(e);
      res.status(400).json({
        ok: false,
        error: /401/.test(m) ? 'Asana rejected that token' : m,
      });
    }
  });

  api.get('/sources/:source/items', async (req, res) => {
    const repo = repos().find((r) => r.name === req.query.repo);
    const out = await sources.list(cfg, req.params.source, { repoPath: repo?.path, q: req.query.q });
    res.json(out);
  });
}

export { register };
