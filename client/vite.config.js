import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// This file runs in Node, but the client's jsconfig has no @types/node — so reach the
// environment through globalThis rather than dragging a whole type package in for it.
const env = /** @type {Record<string, string|undefined>} */ (
  (/** @type {any} */ (globalThis).process?.env) ?? {}
);

// The daemon's dev address. Vite serves the UI; everything stateful still comes from
// the real Express process, so `npm run dev` here talks to live tmux sessions.
//
// Overridable so a second daemon can be run from a worktree on a spare port without
// editing this file (and without two people's dev servers fighting over 5273):
//   WT_STUDIO_DAEMON=http://127.0.0.1:7801 WT_STUDIO_DEV_PORT=5281 npm run dev
// The defaults are unchanged — with no env set this behaves exactly as before.
const DAEMON = env.WT_STUDIO_DAEMON || 'http://127.0.0.1:7788';
const DEV_PORT = Number(env.WT_STUDIO_DEV_PORT || 5273);
const PREVIEW_PORT = Number(env.WT_STUDIO_PREVIEW_PORT || 5274);

const proxy = {
  // Covers /api/state, /api/events (SSE) and every action endpoint. SSE works through
  // this untouched because Vite streams proxied responses rather than buffering them.
  '/api': { target: DAEMON, changeOrigin: false },
  // `ws: true` makes Vite forward the HTTP Upgrade handshake instead of trying to
  // answer it — without this the terminal socket 404s in dev and only in dev.
  '/ws': { target: DAEMON, changeOrigin: false, ws: true },
};

export default defineConfig({
  plugins: [sveltekit()],
  server: { port: DEV_PORT, strictPort: true, proxy },
  // `vite preview` gets the same proxy so the built output can be exercised against the
  // real daemon before it is wired into Express — otherwise the only way to test the
  // production bundle is to change server.js, which is exactly what this avoids.
  preview: { port: PREVIEW_PORT, strictPort: true, proxy },
});
