// A second dev config, for developing the insights surfaces against a scratch daemon.
//
// vite.config.js targets the real daemon on 7788 and binds 5273. The transcript search
// and telemetry routes only exist in a daemon started from THIS worktree, and running
// one on 7788 would fight the user's live instance — so this config exists purely so
// the two can run side by side. It is additive: vite.config.js is untouched, which
// keeps this branch from colliding with the shell port happening in parallel.
//
//   WT_STUDIO_CONFIG=<tmp>/config.json WT_STUDIO_STATE=<tmp>/state node server/server.js
//   npm run dev -- -c vite.insights.config.js
//
// Both values are overridable so this doesn't hardcode one agent's port choice.
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const DAEMON = process.env.WT_STUDIO_DEV_DAEMON || 'http://127.0.0.1:7802';
const PORT = Number(process.env.WT_STUDIO_DEV_PORT) || 5275;

const proxy = {
  '/api': { target: DAEMON, changeOrigin: false },
  '/ws': { target: DAEMON, changeOrigin: false, ws: true },
};

export default defineConfig({
  plugins: [sveltekit()],
  server: { port: PORT, strictPort: true, proxy },
  preview: { port: PORT + 1, strictPort: true, proxy },
});
