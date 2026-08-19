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
//
// The document is also the one response that *hands out* the token, so it is gated on
// the token itself — see requireToken below. The Host/Origin gate in front of the whole
// app stops a browser being used as the proxy; it says nothing about the local process
// that simply asks. Before this gate, `curl 127.0.0.1:7788/` printed the live token to
// any process on the machine, which turned a 401'd API into an open one.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from './security.ts';

const ROOT = path.join(import.meta.dirname, '..');
const PLACEHOLDER = '__WTS_TOKEN__';
const BUILD_PLACEHOLDER = '__WTS_BUILD__';

/**
 * An id for the bundle currently on disk: the first 12 hex of a digest of index.html.
 *
 * index.html is the right file to hash because SvelteKit rewrites the hashed asset URLs
 * inside it on every build, so its bytes move if and only if the bundle moved. It is also
 * tiny, which is what makes hashing it per document response affordable.
 *
 * Empty string when the build is absent or unreadable — a daemon must not fail to boot,
 * and `mountFallback` already answers a missing build with its own clear error.
 */
function buildId(indexPath: string): string {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(indexPath)).digest('hex').slice(0, 12);
  } catch {
    return '';
  }
}

// The cookie the tab authenticates with on every later navigation (reload, deep link,
// bookmark). Deliberately NOT HttpOnly: the SPA reads it to authenticate its own fetches
// when the injected global is missing, and hiding it from script would buy nothing —
// the same document already carries the token in its body.
const COOKIE = 'wts_token';
// Long-lived because the token itself is long-lived (security.ts keeps it across
// restarts): a session cookie would send every bookmarked tab back to the challenge page
// after each browser quit, and the fix for that is to paste the token into a URL again,
// which is the thing we are trying to make rare.
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Where the client lives, resolved and proven to be on disk. */
export interface ResolvedUi {
  label: string;
  root: string;
  index: string;
}

/** The document handler's two inputs, shared by both mounts. */
interface MountOptions {
  ui: ResolvedUi;
  /**
   * The bundle id captured when the daemon booted, reported by GET /state.
   * Optional: a caller that does not pass one simply has no skew to detect.
   */
  bootBuildId?: string;
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
  /*
   * The build id is read PER RESPONSE, not captured once.
   *
   * That is the whole mechanism: this reports the bundle the browser is about to run,
   * while GET /state reports the one the daemon booted with. Capturing it here too would
   * make the two agree by construction and detect nothing.
   */
  return framed(res)
    .type('html')
    .set('Cache-Control', 'no-store')
    .send(html.split(PLACEHOLDER).join(token).split(BUILD_PLACEHOLDER).join(buildId(ui.index)));
}

// Framing defenses on every document response.
//
// The tab holds the token, so a page that can frame it can drive the studio through
// clickjacking — an invisible iframe of the real UI over the attacker's buttons. The
// Host gate does not help: the frame is loaded from 127.0.0.1, so it carries the honest
// Host and gets a real document.
//
// Framing only, on purpose. The document is a bundled SPA with inline boot script and
// hashed asset URLs; a default-src/script-src policy tight enough to be worth having
// would break it, and it would break it *silently* — a blank page with a console error
// nobody is watching. frame-ancestors is the one directive that costs nothing here.
function framed(res: Response): Response {
  return res.set('X-Frame-Options', 'DENY').set('Content-Security-Policy', "frame-ancestors 'none'");
}

// The Cookie header, parsed for our one cookie. No cookie-parser dependency: one name,
// and a `document.cookie`-shaped split is the whole of it.
function cookieToken(req: Request): string {
  const raw = req.headers.cookie;
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value; // a value we cannot decode simply will not match
    }
  }
  return '';
}

// What the browser is shown when it has no token. It must never contain the token, and
// it must say what to do instead — a bare 401 for the *whole UI* reads as "the daemon is
// broken", and the next move is usually to disable the check.
function sendChallenge(res: Response): Response {
  return framed(res)
    .status(401)
    .type('html')
    .set('Cache-Control', 'no-store')
    .send(
      `<!doctype html><meta charset="utf-8"><title>Worktree Studio — token required</title>` +
        `<style>body{font:14px/1.6 -apple-system,system-ui,sans-serif;margin:12vh auto;max-width:34rem;padding:0 1.5rem;color:#222}` +
        `code{font:12.5px ui-monospace,Menlo,monospace;background:#f2f2f2;padding:1px 5px;border-radius:4px}</style>` +
        `<h1>Token required</h1>` +
        `<p>This page hands out the boot token that can start sessions and open terminals, ` +
        `so it is only served to a client that already has the token.</p>` +
        `<p>Open the UI once with the token in the URL and it is remembered in a cookie:</p>` +
        `<pre><code>open "http://127.0.0.1:$(jq -r '.web.port // 7788' ~/.config/worktree-studio/config.json)/?token=$(cat ~/.local/state/worktree-studio/token)"</code></pre>` +
        `<p>The token file is <code>token</code> in the studio state directory ` +
        `(<code>~/.local/state/worktree-studio</code> unless <code>WT_STUDIO_STATE</code> says otherwise).</p>`,
    );
}

// Serve the document only to a request that already proves it has the token.
//
// Three ways in, in the order they occur in a tab's life:
//   ?token=…   the initial navigation from a launcher or a pasted URL. Accepted once,
//              turned into a cookie, then redirected away so the token does not sit in
//              browser history, in the referrer of the first outbound link, or in a
//              screen-shared address bar.
//   cookie     every navigation after that, including reloads and deep links.
//   header     non-browser clients that fetch the shell (tests, curl with the token).
function requireToken(ui: ResolvedUi, token: string, req: Request, res: Response): Response {
  const q = req.query?.token;
  if (q !== undefined) {
    if (!timingSafeEqual(String(q), token)) return sendChallenge(res);
    const url = new URL(req.originalUrl || req.url || '/', 'http://127.0.0.1');
    url.searchParams.delete('token');
    res.cookie(COOKIE, token, {
      path: '/',
      // Strict, not Lax: nothing legitimate navigates into the studio from another
      // site, and Lax would attach the cookie to a top-level GET a hostile page
      // triggered — which is exactly the request that would be handed the token back.
      sameSite: 'strict',
      httpOnly: false,
      maxAge: COOKIE_MAX_AGE_MS,
    });
    framed(res).set('Cache-Control', 'no-store').redirect(303, `${url.pathname}${url.search}`);
    return res;
  }
  const header = String(req.headers['x-wts-token'] || '');
  if (timingSafeEqual(header, token) || timingSafeEqual(cookieToken(req), token))
    return sendIndex(ui, token, res);
  return sendChallenge(res);
}

// The document + its assets. Mounted before the API routes, like any static mount.
function mount(app: Express, { ui, token }: MountOptions): void {
  app.get(['/', '/index.html'], (req: Request, res: Response) => requireToken(ui, token, req, res));
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
    // Same gate as '/': a deep link is a document too, and a fallback that skipped the
    // check would be the same token oracle one path further along.
    return requireToken(ui, token, req, res);
  });
}

export { resolve, mount, mountFallback, buildId, PLACEHOLDER, BUILD_PLACEHOLDER };
