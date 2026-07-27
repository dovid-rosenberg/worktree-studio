// Pure SPA. Nothing here can be rendered ahead of time: every screen is a projection
// of tmux/git state that only the running daemon knows, and the terminal needs a live
// WebSocket, so a prerender pass would only ever produce a shell that must be thrown
// away on hydrate.
export const ssr = false;
export const prerender = false;

// The daemon serves one fallback file for every path, so the client must decide which
// route it is on from the URL alone rather than from a server-provided manifest.
export const trailingSlash = 'never';
