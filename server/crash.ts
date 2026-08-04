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
import type { ErrorRequestHandler, NextFunction } from 'express';

/**
 * The request and response typed by the four members this middleware touches, not by
 * express's own `Request`/`Response` — those are ~100-member interfaces, and a test
 * that wants to check WHAT gets logged and answered should not have to build one.
 * Real express objects satisfy both. `routeErrors()` is still returned as an
 * `ErrorRequestHandler`, so `app.use()` accepts it unchanged.
 */
export interface ErrorRequest {
  method: string;
  originalUrl?: string;
  url?: string;
}

export interface ErrorResponse {
  headersSent: boolean;
  status(code: number): { json(body: unknown): unknown };
}

// Errors confined to one already-dead socket. `code` is the only reliable
// discriminator — the message is localized/formatted and the class isn't
// (Node throws plain Error for most of these).
const CONNECTION_ERROR_CODES = new Set([
  'EPIPE', // wrote to a peer that closed its end
  'ECONNRESET', // peer reset mid-exchange
  'ERR_STREAM_DESTROYED', // stream torn down under an in-flight write
  'ERR_STREAM_WRITE_AFTER_END', // ditto, after the writable side finished
  'ERR_STREAM_ALREADY_FINISHED',
]);

// What a thrown value might turn out to carry. Nothing guarantees a throw is even
// an Error — a plain string or an undefined reaches these handlers just the same —
// so every field is optional and every read of one goes through this.
interface Thrown {
  code?: string;
  status?: number;
  statusCode?: number;
  message?: string;
}

// Is this error confined to a single connection that is already lost?
function isConnectionError(err: unknown): err is { code: string } {
  if (!err || typeof err !== 'object') return false;
  const { code } = err as Thrown;
  return code !== undefined && CONNECTION_ERROR_CODES.has(code);
}

/** Where a listen was attempted, for the message. */
interface Addr {
  host?: string;
  port?: number | string;
}

// A human line explaining a fatal listen failure, or null if `err` isn't one.
// EADDRINUSE is the case worth spelling out: it is nearly always a second daemon
// being started against a port the first one already owns, and the generic
// stack trace buries that.
function listenErrorMessage(err: unknown, { host, port }: Addr = {}): string | null {
  if (!err || typeof err !== 'object') return null;
  const { code } = err as Thrown;
  const at = `${host || '?'}:${port || '?'}`;
  if (code === 'EADDRINUSE')
    return `port ${port} is already in use — something is already listening on ${at} (another Studio daemon?). Refusing to run without an HTTP server.`;
  if (code === 'EACCES')
    return `not allowed to bind ${at} — ports below 1024 need privileges. Pick another port in config.json (web.port).`;
  if (code === 'EADDRNOTAVAIL') return `cannot bind ${at} — that address does not exist on this machine.`;
  return null;
}

interface Io {
  log?: (...args: unknown[]) => void;
  exit?: (code: number) => void;
}

interface InstallIo extends Io {
  on?: (event: string, listener: (err: unknown) => void) => unknown;
}

/**
 * Install the policy. `log`/`exit`/`on` are injectable so the classification can
 * be driven in a test without arming real process handlers or killing the runner.
 *
 * `handleException` reports whether the error was survived (true) or fatal
 * (false), for tests.
 */
function install({
  log = console.error,
  exit = process.exit,
  on = process.on.bind(process),
}: InstallIo = {}): { handleException(err: unknown): boolean } {
  function handle(kind: string, err: unknown): boolean {
    if (isConnectionError(err)) {
      // One connection died under a write. Say so at a level nobody greps for a
      // stack trace in, and carry on serving everyone else.
      log(`[wt-studio] ${kind}: ${err.code} on a client connection — that connection is gone, continuing`);
      return true;
    }
    log(
      `[wt-studio] fatal ${kind} — exiting so this is visible instead of running on in an unknown state`,
      err,
    );
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

/** an http.Server, typed by the one thing this touches */
interface ListenErrorSource {
  on(event: 'error', listener: (err: unknown) => void): unknown;
}

/**
 * Make a listen failure fatal at its source. An 'error' event on an http.Server
 * with no listener is re-thrown as an uncaughtException, which is how EADDRINUSE
 * ever reached the blanket handler in the first place; handling it here is what
 * turns it into a sentence the user can act on.
 */
function guardListen(
  server: ListenErrorSource,
  { host, port }: Addr = {},
  { log = console.error, exit = process.exit }: Io = {},
): void {
  server.on('error', (err: unknown) => {
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
function routeErrors({ log = console.error }: Pick<Io, 'log'> = {}) {
  // Four arity, or express registers this as an ordinary middleware and never
  // hands it an error.
  const handler = (err: unknown, req: ErrorRequest, res: ErrorResponse, next: NextFunction) => {
    // Headers already out (an SSE stream, a half-written document): there is no
    // status left to set, and appending JSON to a body in flight corrupts it. Hand
    // it to express's default handler, which destroys the socket instead.
    if (res.headersSent) return next(err);
    // originalUrl, not url, and without the query string — same reasons as
    // security.ts's refusal log: the query carries the boot token.
    const where = `${req.method} ${String(req.originalUrl || req.url || '').split('?')[0]}`;
    log(`[wt-studio] ${where}`, err);
    // A body parser refusing a malformed or oversized body sets its own status, and
    // a 400/413 is something the caller can act on — unlike the 500 that an escaped
    // throw is. Only an error naming no status is an unhandled exception.
    const e = err as Thrown | null | undefined;
    const status = Number(e && (e.status || e.statusCode));
    res.status(status >= 400 && status <= 599 ? status : 500).json({ error: e?.message });
  };
  return handler as typeof handler & ErrorRequestHandler;
}

export { install, guardListen, routeErrors, isConnectionError, listenErrorMessage, CONNECTION_ERROR_CODES };
