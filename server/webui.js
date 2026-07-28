'use strict';
// Which frontend the daemon serves, and how the boot token gets into it.
//
// The served UI is the SvelteKit build in `client/build` (adapter-static, SPA mode):
// plain files, no second server and no second port — this daemon stays the only one.
// `public/` is still in the tree and still works; WTS_UI=legacy serves it instead, so
// a regression in the new UI is one env var away from being worked around rather than
// a revert. Exactly one of them owns `/`: resolve() picks a single root, and both the
// document handler and the static mount are built from that one choice.
//
// The token can only reach the tab through the document we hand it (see security.js),
// so the document is served by a handler that substitutes it — never by the static
// middleware, and never from disk with the real token baked in. `index: false` on the
// static mount is what guarantees the un-injected file can't leak out the side door.
const fs = require('fs');
const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const PLACEHOLDER = '__WTS_TOKEN__';

const UIS = {
  // name → where it lives (relative to the repo root), and what to tell the user when
  // it isn't there.
  client: {
    dir: ['client', 'build'],
    label: 'SvelteKit client (client/build)',
    missing: 'the client has not been built yet — run `npm run build` (or `npm install`, which builds it).\n'
      + 'To fall back to the previous UI while you sort it out, start with WTS_UI=legacy.',
  },
  legacy: {
    dir: ['public'],
    label: 'legacy UI (public/)',
    missing: 'public/index.html is missing.',
  },
};

const NAMES = Object.keys(UIS);

// Pick the UI and prove it is actually on disk. Throws with an actionable message
// rather than letting the daemon boot and answer `/` with a 500 or a blank page —
// a UI that isn't there is a startup error, not a per-request one.
// `root` is the repo root; it is a parameter only so tests can point at a fixture tree.
function resolve(env = process.env, root = ROOT) {
  const name = String(env.WTS_UI || 'client').trim().toLowerCase() || 'client';
  const ui = UIS[name];
  if (!ui) throw new Error(`WTS_UI=${name} is not a UI — use one of: ${NAMES.join(', ')}`);
  const uiRoot = path.join(root, ...ui.dir);
  const index = path.join(uiRoot, 'index.html');
  if (!fs.existsSync(index)) throw new Error(`cannot serve the ${ui.label}: ${ui.missing}`);
  return { name, label: ui.label, root: uiRoot, index };
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
function sendIndex(ui, token, res) {
  let html;
  try { html = fs.readFileSync(ui.index, 'utf8'); } catch { return res.status(500).send('index.html is missing'); }
  return res.type('html').set('Cache-Control', 'no-store').send(html.split(PLACEHOLDER).join(token));
}

// The document + its assets. Mounted before the API routes, like any static mount.
function mount(app, { ui, token }) {
  app.get(['/', '/index.html'], (req, res) => sendIndex(ui, token, res));
  // index:false so the static middleware can never serve the un-injected index.html.
  app.use(express.static(ui.root, { index: false }));
}

// The SPA fallback. The client has real routes (/review, /search, /usage), and a deep
// link or a reload on one of them is the document the tab boots from — so it has to go
// through the same injector, not sendFile, or the token placeholder ships unsubstituted.
//
// Mount this AFTER every API route: it answers any GET, so anything registered later is
// unreachable. /api and /ws are skipped anyway, because an unknown API path must stay a
// 404 for SwiftBar, Alfred and the CLI rather than becoming 200 text/html.
// express@4 is what this repo pins, so '*' is the right pattern (express@5: '/*splat').
function mountFallback(app, { ui, token }) {
  app.get('*', (req, res, next) => {
    if (req.path === '/api' || req.path.startsWith('/api/') || req.path.startsWith('/ws/')) return next();
    return sendIndex(ui, token, res);
  });
}

module.exports = { resolve, mount, mountFallback, PLACEHOLDER, NAMES };
