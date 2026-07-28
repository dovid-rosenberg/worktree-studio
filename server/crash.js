// Crash policy: what happens when something throws. Process-level first
// (install/guardListen), then the request-level counterpart (routeErrors) at the
// bottom — the two interlock, and reading either without the other is how a route
// failure ends up classified as a fatal one.
//
// Studio used to install `process.on('uncaughtException', log)` and
// `process.on('unhandledRejection', log)` — a blanket "log it and keep going".
// That turned every fatal condition into a silent one. The incident it caused:
// a second daemon whose `listen()` failed with EADDRINUSE stayed alive anyway,
// with no HTTP server but a live watcher, a live tmux client and a live state
// file — so zombie daemons accumulated and wrote to the user's real state dir.
//
// The policy here is the inverse, and it is Node's own default for a reason: an
// uncaught exception is by definition a throw that escaped every handler we
// wrote, so the process is in a state nobody reasoned about. A daemon that dies
// loudly gets noticed and restarted with its state intact; one that survives in
// an unknown state corrupts that state at leisure.
//
// The exemption is deliberately not "errors we'd rather not die on" — that is
// just a smaller blanket. It is one structural class: an error whose entire
// blast radius is a single socket that is ALREADY gone. A client that vanished
// mid-write (EPIPE / ECONNRESET) or a stream that was destroyed under an
// in-flight write carries no state beyond that connection, and no amount of
// exiting brings the connection back. Studio holds long-lived sockets it does
// not control — SSE subscribers, terminal WebSockets — so this class is real
// and routine here. Anything else, including any error with no `code` at all
// (which is what a programming bug looks like), is fatal.
//
// Note what is NOT on the list: EADDRINUSE, EACCES, ENOENT, ENOSPC. Those say
// the environment is not what the process needs, and continuing means running
// half-configured.

// Errors confined to one already-dead socket. `code` is the only reliable
// discriminator — the message is localized/formatted and the class isn't
// (Node throws plain Error for most of these).
const CONNECTION_ERROR_CODES = new Set([
  'EPIPE',                        // wrote to a peer that closed its end
  'ECONNRESET',                   // peer reset mid-exchange
  'ERR_STREAM_DESTROYED',         // stream torn down under an in-flight write
  'ERR_STREAM_WRITE_AFTER_END',   // ditto, after the writable side finished
  'ERR_STREAM_ALREADY_FINISHED',
]);

// Is this error confined to a single connection that is already lost?
function isConnectionError(err) {
  return !!err && typeof err === 'object' && CONNECTION_ERROR_CODES.has(err.code);
}

/** Where a listen was attempted, for the message. @typedef {{ host?: string, port?: number|string }} Addr */

// A human line explaining a fatal listen failure, or null if `err` isn't one.
// EADDRINUSE is the case worth spelling out: it is nearly always a second daemon
// being started against a port the first one already owns, and the generic
// stack trace buries that.
/** @param {*} err @param {Addr} [addr] */
function listenErrorMessage(err, { host, port } = {}) {
  if (!err || typeof err !== 'object') return null;
  const at = `${host || '?'}:${port || '?'}`;
  if (err.code === 'EADDRINUSE') return `port ${port} is already in use — something is already listening on ${at} (another Studio daemon?). Refusing to run without an HTTP server.`;
  if (err.code === 'EACCES') return `not allowed to bind ${at} — ports below 1024 need privileges. Pick another port in config.json (web.port).`;
  if (err.code === 'EADDRNOTAVAIL') return `cannot bind ${at} — that address does not exist on this machine.`;
  return null;
}

/**
 * Install the policy. `log`/`exit`/`on` are injectable so the classification can
 * be driven in a test without arming real process handlers or killing the runner.
 * @param {object} [io]
 * @param {(...args: any[]) => void} [io.log]
 * @param {(code: number) => void} [io.exit]
 * @param {(event: string, listener: (err: any) => void) => any} [io.on]
 * @returns {{ handleException(err: any): boolean }} handleException reports whether the
 *          error was survived (true) or fatal (false), for tests.
 */
function install({ log = console.error, exit = process.exit, on = process.on.bind(process) } = {}) {
  function handle(kind, err) {
    if (isConnectionError(err)) {
      // One connection died under a write. Say so at a level nobody greps for a
      // stack trace in, and carry on serving everyone else.
      log(`[wt-studio] ${kind}: ${err.code} on a client connection — that connection is gone, continuing`);
      return true;
    }
    log(`[wt-studio] fatal ${kind} — exiting so this is visible instead of running on in an unknown state`, err);
    exit(1);
    return false;
  }
  on('uncaughtException', (err) => handle('uncaughtException', err));
  // An unhandled rejection is the same failure reached through `await`. Node has
  // crashed on it by default since v15; swallowing it here re-created the pre-v15
  // behavior Node abandoned precisely because it hid broken state.
  on('unhandledRejection', (err) => handle('unhandledRejection', err));
  return { handleException: (err) => handle('uncaughtException', err) };
}

/**
 * Make a listen failure fatal at its source. An 'error' event on an http.Server
 * with no listener is re-thrown as an uncaughtException, which is how EADDRINUSE
 * ever reached the blanket handler in the first place; handling it here is what
 * turns it into a sentence the user can act on.
 * @param {{ on: (event: string, listener: (err: any) => void) => any }} server
 *        an http.Server, typed by the one thing this touches
 * @param {Addr} [addr]
 * @param {{ log?: Function, exit?: Function }} [io]
 */
function guardListen(server, { host, port } = {}, { log = console.error, exit = process.exit } = {}) {
  server.on('error', (err) => {
    const why = listenErrorMessage(err, { host, port });
    if (why) log(`[wt-studio] ${why}`);
    else log('[wt-studio] fatal http server error', err);
    exit(1);
  });
}

/**
 * The request-level half of the policy above, as express error middleware.
 *
 * install() makes an unhandled rejection fatal — Node's own default, and the right
 * default for state nobody reasoned about. But a route handler that throws is NOT
 * that: its blast radius is one request, and the caller is owed an answer. express@5
 * is what makes the distinction expressible — it awaits handlers and forwards a
 * rejection here, where express@4 let it escape to the process. That is why the
 * per-handler `A()` wrapper this replaces could be deleted rather than re-homed:
 * with express@4 a handler somebody forgot to wrap was a daemon-killer, and now
 * there is nothing to forget.
 *
 * Mount it LAST — after every route including the SPA fallback — or the layers
 * registered after it are outside the net.
 */
function routeErrors({ log = console.error } = {}) {
  // Four arity, or express registers this as an ordinary middleware and never
  // hands it an error.
  return (err, req, res, next) => {
    // Headers already out (an SSE stream, a half-written document): there is no
    // status left to set, and appending JSON to a body in flight corrupts it. Hand
    // it to express's default handler, which destroys the socket instead.
    if (res.headersSent) return next(err);
    // originalUrl, not url, and without the query string — same reasons as
    // security.js's refusal log: the query carries the boot token.
    const where = `${req.method} ${String(req.originalUrl || req.url || '').split('?')[0]}`;
    log(`[wt-studio] ${where}`, err);
    // A body parser refusing a malformed or oversized body sets its own status, and
    // a 400/413 is something the caller can act on — unlike the 500 that an escaped
    // throw is. Only an error naming no status is an unhandled exception.
    const status = Number(err && (err.status || err.statusCode));
    res.status(status >= 400 && status <= 599 ? status : 500).json({ error: err && err.message });
  };
}

export { install, guardListen, routeErrors, isConnectionError, listenErrorMessage, CONNECTION_ERROR_CODES };
