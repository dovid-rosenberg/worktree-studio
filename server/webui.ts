// The frontend the daemon serves, and how the boot token gets into it.
//
// One UI: the SvelteKit build in `client/build` (adapter-static, SPA mode) — plain
// files, no second server and no second port, so this daemon stays the only one.
//
// There used to be a registry here and a `WTS_UI=legacy` escape hatch pointing at a
// hand-written `public/` UI. That UI is gone, so the registry is too: a lookup table
// with one entry is indirection, and an env var that can only ever resolve to the
// default is a promise the code cannot keep.
//
// The token can only reach the tab through the document we hand it (see security.ts),
// so the document is served by a handler that substitutes it — never by the static
// middleware, and never from disk with the real token baked in. `index: false` on the
// static mount is what guarantees the un-injected file can't leak out the side door.
import fs from 'fs';
import path from 'path';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';

const ROOT = path.join(import.meta.dirname, '..');
const PLACEHOLDER = '__WTS_TOKEN__';

/** Where the client lives, resolved and proven to be on disk. */
export interface ResolvedUi {
  label: string;
  root: string;
  index: string;
}

/** The document handler's two inputs, shared by both mounts. */
interface MountOptions {
  ui: ResolvedUi;
  token: string;
}

// Prove the client is actually built. Throws with an actionable message rather than
// letting the daemon boot and answer `/` with a 500 or a blank page — a UI that isn't
// there is a startup error, not a per-request one.
//
// `root` is the repo root; it is a parameter so tests can point at a fixture tree, and
// `WT_STUDIO_UI_ROOT` is the same seam for a test that spawns a real daemon rather than
// calling this directly. It overrides the location, never the UI: there is one client,
// and this cannot select a different one.
function resolve(root: string = process.env.WT_STUDIO_UI_ROOT || ROOT): ResolvedUi {
  const uiRoot = path.join(root, 'client', 'build');
  const index = path.join(uiRoot, 'index.html');
  if (!fs.existsSync(index)) {
    throw new Error(
      'cannot serve the client: it has not been built yet — run `npm run build` ' +
        '(or `npm install`, which builds it).',
    );
  }
  return { label: 'SvelteKit client (client/build)', root: uiRoot, index };
}

// Read the shell and substitute the token. Cache-Control: no-store keeps the token
// out of the disk cache; the read is per-request so a rebuild is picked up without a
// daemon restart.
//
// Every occurrence is replaced, not just the first. app.html carries the placeholder
// exactly once and says so, but a single `String.replace` makes that comment
// load-bearing: add a second mention (a comment is enough) ahead of the real one and
// the document ships `window.WTS_TOKEN = "__WTS_TOKEN__"` verbatim, which 401s every
// API call from a page that otherwise looks fine.
function sendIndex(ui: ResolvedUi, token: string, res: Response): Response {
  let html: string;
  try {
    html = fs.readFileSync(ui.index, 'utf8');
  } catch {
    return res.status(500).send('index.html is missing');
  }
  return res.type('html').set('Cache-Control', 'no-store').send(html.split(PLACEHOLDER).join(token));
}

// The document + its assets. Mounted before the API routes, like any static mount.
function mount(app: Express, { ui, token }: MountOptions): void {
  app.get(['/', '/index.html'], (_req: Request, res: Response) => sendIndex(ui, token, res));
  // index:false so the static middleware can never serve the un-injected index.html.
  app.use(express.static(ui.root, { index: false }));
}

// The SPA fallback: a deep link or a reload is the document the tab boots from, so it
// has to go through the same injector, not sendFile, or the token placeholder ships
// unsubstituted.
//
// Mount this AFTER every API route: it answers any GET, so anything registered later is
// unreachable. /api and /ws are skipped anyway, because an unknown API path must stay a
// 404 for SwiftBar, Alfred and the CLI rather than becoming 200 text/html.
//
// express@5 (path-to-regexp v8) dropped bare '*' as a path. The braces matter: '/*splat'
// alone matches one-or-more segments and so does NOT match '/', while '/{*splat}' makes
// the wildcard optional and is the exact equivalent of express@4's '*'. mount() claims
// '/' above, so today the difference is invisible — but a fallback that silently stops
// covering '/' the moment it is mounted without mount() is a trap, not a saving.
function mountFallback(app: Express, { ui, token }: MountOptions): void {
  app.get('/{*splat}', (req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/api' || req.path.startsWith('/api/') || req.path.startsWith('/ws/')) return next();
    return sendIndex(ui, token, res);
  });
}

export { resolve, mount, mountFallback, PLACEHOLDER };
