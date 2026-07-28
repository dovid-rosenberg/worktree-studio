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

/*
 * The dev server and the daemon are on different ports, and server/security.js checks
 * BOTH `Host` and `Origin` against the daemon's own bind address (that pair is the
 * DNS-rebinding defence — see the header of security.js). A dev request forwarded
 * verbatim therefore arrives claiming `localhost:5273`, and is refused with
 * `403 forbidden host` before any handler sees it.
 *
 * So the proxy has to present itself as the daemon's own origin:
 *   changeOrigin: true   rewrites Host to the target's host:port
 *   headers.origin       rewrites the Origin the browser attached to POSTs
 *
 * This is not a weakening of the gate. The gate exists to stop a *page* from reaching
 * the daemon; here the rewrite happens in a Node process on the user's machine that the
 * user started, one hop after Vite has already decided the request came from its own
 * origin. A hostile page still cannot reach the daemon — it cannot reach this proxy
 * either, and it does not have the token.
 */
const asDaemon = { target: DAEMON, changeOrigin: true, headers: { origin: DAEMON } };

const proxy = {
  // Covers /api/state, /api/events (SSE) and every action endpoint. SSE works through
  // this untouched because Vite streams proxied responses rather than buffering them.
  '/api': { ...asDaemon },
  // `ws: true` makes Vite forward the HTTP Upgrade handshake instead of trying to
  // answer it — without this the terminal socket 404s in dev and only in dev.
  '/ws': { ...asDaemon, ws: true },
};

export default defineConfig(({ command }) => ({
  plugins: [sveltekit()],
  /*
   * How the dev client gets the boot token.
   *
   * In production the daemon injects it into the document it serves (the __WTS_TOKEN__
   * placeholder in app.html). Dev has no daemon in front of the document — Vite serves
   * it — so the placeholder would survive and every /api call would 401.
   *
   * `define` is the right tool because it is decided by `command`: it is applied for
   * `serve` (dev and preview) and NEVER for `build`, so the token cannot end up written
   * into build/index.html or a hashed chunk on disk. On a build the identifier is
   * statically replaced with `''` and the client falls back to window.WTS_TOKEN, which
   * is the only path production ever takes.
   */
  define: {
    'import.meta.env.VITE_WTS_TOKEN': JSON.stringify(command === 'serve' ? readToken() : ''),
  },
  server: { port: 5273, strictPort: true, proxy },
  // `vite preview` gets the same proxy so the built output can be exercised against the
  // real daemon before it is wired into Express — otherwise the only way to test the
  // production bundle is to change server.js, which is exactly what this avoids.
  preview: { port: 5274, strictPort: true, proxy },
}));
