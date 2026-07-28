// @ts-nocheck — this file runs in Node, but svelte-check type-checks the project with
// the browser lib set only. Rather than pull in @types/node for one config file, opt it
// out; nothing here ships to the client.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

/*
 * The daemon's dev address. Vite serves the UI; everything stateful still comes from the
 * real Express process, so `npm run dev` here talks to live tmux sessions.
 *
 * WTS_DAEMON overrides it, which is how you point the dev server at a throwaway daemon
 * (its own config + state dir + port) instead of the one you actually work in:
 *
 *   WT_STUDIO_CONFIG=/tmp/x/config.json WT_STUDIO_STATE=/tmp/x/state node server/server.js
 *   WTS_DAEMON=http://127.0.0.1:7803 WT_STUDIO_STATE=/tmp/x/state npm run dev
 */
const DAEMON = process.env.WTS_DAEMON || 'http://127.0.0.1:7788';

/*
 * The boot token lives at <stateDir>/token, mode 0600 (server/security.js). WT_STUDIO_STATE
 * moves the state dir, so honour it here for the same reason the server does.
 */
const STATE_DIR = process.env.WT_STUDIO_STATE
  || path.join(os.homedir(), '.local', 'state', 'worktree-studio');

function readToken() {
  try { return fs.readFileSync(path.join(STATE_DIR, 'token'), 'utf8').trim(); }
  catch { return ''; }
}

/**
 * In production the daemon substitutes the token into the document it serves. Vite
 * serves the document in dev and in preview, so it has to do the same substitution —
 * otherwise those are the one build of the app with no way to authenticate, and every
 * /api call 401s.
 *
 * `apply: 'serve'` is load-bearing: it keeps this OUT of `vite build`, so the token is
 * never written into `build/index.html` on disk. The built file ships the placeholder
 * and the daemon fills it in per response, with `Cache-Control: no-store`.
 *
 * The token is read per request, not at config load: it is generated on the daemon's
 * first run, which may well happen after `npm run dev` started.
 */
const wtsToken = {
  name: 'wts-token',
  apply: /** @type {const} */ ('serve'),
  transformIndexHtml(/** @type {string} */ html) {
    return html.replace('__WTS_TOKEN__', readToken());
  },
  // `vite preview` serves the built files statically and never calls transformIndexHtml,
  // so the same substitution is applied here by hand.
  configurePreviewServer(/** @type {any} */ server) {
    server.middlewares.use((/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ next) => {
      const url = String(req.url || '').split('?')[0];
      if (url !== '/' && url !== '/index.html') return next();
      let html;
      try { html = fs.readFileSync(path.join(import.meta.dirname, 'build', 'index.html'), 'utf8'); }
      catch { return next(); }
      res.setHeader('content-type', 'text/html');
      res.setHeader('cache-control', 'no-store');
      res.end(html.replace('__WTS_TOKEN__', readToken()));
    });
  },
};

const proxy = {
  // Covers /api/state, /api/events (SSE) and every action endpoint. SSE works through
  // this untouched because Vite streams proxied responses rather than buffering them.
  '/api': { target: DAEMON, changeOrigin: false },
  // `ws: true` makes Vite forward the HTTP Upgrade handshake instead of trying to
  // answer it — without this the terminal socket 404s in dev and only in dev.
  '/ws': { target: DAEMON, changeOrigin: false, ws: true },
};

export default defineConfig({
  plugins: [sveltekit(), wtsToken],
  server: { port: 5273, strictPort: true, proxy },
  // `vite preview` gets the same proxy so the built output can be exercised against the
  // real daemon before it is wired into Express — otherwise the only way to test the
  // production bundle is to change server.js, which is exactly what this avoids.
  preview: { port: 5274, strictPort: true, proxy },
});
