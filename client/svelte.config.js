import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    // Static SPA, not a Node server. The Express daemon in server/ owns HTTP, the
    // WebSocket upgrade and every /api route; SvelteKit only ever emits assets it
    // hands to that daemon. adapter-node would mean two servers and two ports.
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      // Every route falls back to one shell that boots client-side — the daemon has no
      // knowledge of client routes, so it must be able to answer any path with this file.
      fallback: 'index.html',
      precompress: false,
      strict: false,
    }),
    // Keep built assets under a path the daemon can serve verbatim next to its own
    // /api and /ws routes without any collision.
    appDir: '_app',
  },
};

export default config;
