import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// The daemon's dev address. Vite serves the UI; everything stateful still comes from
// the real Express process, so `npm run dev` here talks to live tmux sessions.
const DAEMON = 'http://127.0.0.1:7788';

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
  server: { port: 5273, strictPort: true, proxy },
  // `vite preview` gets the same proxy so the built output can be exercised against the
  // real daemon before it is wired into Express — otherwise the only way to test the
  // production bundle is to change server.js, which is exactly what this avoids.
  preview: { port: 5274, strictPort: true, proxy },
});
