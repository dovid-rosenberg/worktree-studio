'use strict';
// The two gates in front of everything this server exposes. They stop different
// attacks, and neither one alone is enough — which is why both exist.
//
// 1. Origin / Host allowlist — stops a *browser the user already has open* from
//    being used as the attacker's proxy. "Loopback-only" is not a boundary in a
//    browser: any page can already send requests to 127.0.0.1. CORS only hides the
//    *response*, and WebSockets are not subject to CORS at all — so without an
//    Origin check, a page on evil.com could open ws://127.0.0.1:7788/ws/term and
//    get a read/write PTY into a live tmux session. Checking `Origin` on the
//    upgrade (before any pty is spawned) closes that.
//    DNS rebinding goes one step further: evil.com re-resolves to 127.0.0.1, so the
//    page *becomes* same-origin and CORS stops applying. The one header that still
//    tells the truth is `Host` — the browser sends the name it was asked for
//    ("evil.com"), not the address it resolved to. Hence the Host allowlist.
//
// 2. Boot token — stops everything that is not the tab we served. The Origin check
//    cannot help there: a non-browser client sets whatever headers it likes, so
//    "Origin absent" has to be allowed (curl, SwiftBar, Alfred, the hook script all
//    send none). A shared secret is the only thing that distinguishes them. It
//    lives in the state dir at mode 0600, so only processes running as this user
//    can read it.
//
// The two interlock: the token reaches the web UI by being injected into the HTML
// we serve, and that is only safe because the Host gate means a rebinding page
// never gets a response to read it out of.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN_FILE = 'token';

// Hostnames that unambiguously mean "this machine, over loopback". A rebinding
// attack cannot produce any of these in the Host header: the browser sends the name
// the user's page was loaded from, and that name is the attacker's domain.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1']);

// Read the boot token, generating it on first run. Deliberately *persistent* rather
// than per-process: every session's generated Claude Code settings file bakes the
// token into its hook URLs, and those files belong to processes that outlive a
// studio restart. A fresh token each boot would silently mute a live session's
// status reporting.
function loadToken(stateDir) {
  const file = path.join(stateDir, TOKEN_FILE);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    // Anything short enough to brute force is treated as absent and replaced.
    if (existing.length >= 32) {
      try { fs.chmodSync(file, 0o600); } catch { /* best effort — a wrong mode is not fatal */ }
      return existing;
    }
  } catch { /* not written yet */ }
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(stateDir, { recursive: true });
  // Write through a temp file with the restrictive mode already set, so the token is
  // never briefly world-readable between creation and chmod.
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return token;
}

// Split a Host/authority into { host, port }. Returns null for anything malformed —
// callers treat that as a denial, so a header we cannot parse is never trusted.
function splitHostPort(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (v.startsWith('[')) { // bracketed IPv6: [::1]:7788
    const end = v.indexOf(']');
    if (end < 0) return null;
    const rest = v.slice(end + 1);
    if (rest && rest[0] !== ':') return null;
    return { host: v.slice(0, end + 1).toLowerCase(), port: rest.slice(1) };
  }
  const i = v.lastIndexOf(':');
  if (i < 0) return { host: v.toLowerCase(), port: '' };
  // More than one colon and no brackets is a bare IPv6 literal — not legal in a Host
  // header, and ambiguous to split, so refuse it rather than guess.
  if (v.indexOf(':') !== i) return null;
  return { host: v.slice(0, i).toLowerCase(), port: v.slice(i + 1) };
}

function timingSafeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length === 0 || x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

// Every check returns null to allow and { status, error } to deny, so callers read
// as `const deny = guard.x(req); if (deny) …` in both express and the raw upgrade
// handler (which has no res to hand to a middleware).
function createGuard({ cfg, token }) {
  // Read the bind config lazily: cfg.web.port is rewritten to the real port when the
  // configured one is 0 (ephemeral), which happens after the guard is built.
  const bindHost = () => String((cfg.web && cfg.web.host) || '127.0.0.1').toLowerCase();
  const bindPort = () => String((cfg.web && cfg.web.port) || '');

  // A refusal is usually a stale client, not an attack, and the client only gets a
  // bare 401/403 — so log one line for the human. Deduplicated per reason for a
  // minute, because a page in a retry loop would otherwise flood the console. Never
  // logs the presented token.
  const loggedAt = new Map();
  function deny(status, error, req) {
    const now = Date.now();
    if (!(loggedAt.get(error) > now - 60000)) {
      loggedAt.set(error, now);
      const h = (req.headers && req.headers.host) || '-';
      const o = (req.headers && req.headers.origin) || '-';
      console.warn(`[wt-studio] refused ${req.method || 'UPGRADE'} ${String(req.url).split('?')[0]} — ${error} (host=${h} origin=${o})`);
    }
    return { status, error };
  }

  function hostAllowed(host) {
    // A non-loopback bind host is an explicit choice by the user (they edited
    // config.web.host); keep that address reachable rather than locking them out.
    return LOOPBACK.has(host) || host === bindHost();
  }
  function portAllowed(port) {
    const want = bindPort();
    if (!want) return true; // ephemeral/unknown bind port — the hostname is the check
    return port === want || (port === '' && (want === '80' || want === '443'));
  }

  // The Host header the client *asked* for. Rejecting anything that is not a
  // loopback name is what defeats DNS rebinding.
  function denyHost(req) {
    const parsed = splitHostPort(req.headers && req.headers.host);
    if (!parsed || !hostAllowed(parsed.host) || !portAllowed(parsed.port)) return deny(403, 'forbidden host', req);
    return null;
  }

  // The page that issued the request, when there is one. Absent is allowed on
  // purpose — every non-browser client (curl, SwiftBar, Alfred, hook script) sends
  // none, and those are gated by the token instead. A browser cannot forge or
  // suppress this header, so "present but wrong" is always an attack.
  // Note `Origin: null` is refused rather than treated as absent: it is what a
  // sandboxed iframe or a data: document sends, i.e. an opaque origin the attacker
  // chose. Nothing legitimate here produces one.
  function denyOrigin(req) {
    const raw = req.headers && req.headers.origin;
    if (!raw) return null;
    let u;
    try { u = new URL(raw); } catch { return deny(403, 'forbidden origin', req); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return deny(403, 'forbidden origin', req);
    const host = u.hostname.toLowerCase();
    // URL normalises [::1] to ::1 in `hostname`; both spellings are in LOOPBACK.
    if (!hostAllowed(host) || !portAllowed(u.port)) return deny(403, 'forbidden origin', req);
    return null;
  }

  function denyBrowser(req) { return denyHost(req) || denyOrigin(req); }

  // The token may arrive as a header (the web UI's fetches, the CLI, SwiftBar,
  // Alfred) or as a query param — EventSource and WebSocket cannot set headers, and
  // neither can the hook URL baked into a session's settings file.
  function presented(req, queryToken) {
    const h = req.headers && req.headers['x-wts-token'];
    if (h) return String(h);
    const auth = (req.headers && req.headers.authorization) || '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) return m[1].trim();
    if (queryToken != null) return String(queryToken);
    if (req.query && req.query.token) return String(req.query.token);
    return '';
  }

  function denyToken(req, queryToken) {
    return timingSafeEqual(presented(req, queryToken), token) ? null : deny(401, 'missing or invalid token', req);
  }

  // Express middleware. `browser` guards everything (including the static assets and
  // the token-bearing index.html); `authed` adds the token and goes on the API router.
  const browser = (req, res, next) => {
    const deny = denyBrowser(req);
    if (deny) return res.status(deny.status).json({ error: deny.error });
    return next();
  };
  const authed = (req, res, next) => {
    const deny = denyToken(req);
    if (deny) return res.status(deny.status).json({ error: deny.error });
    return next();
  };

  return { token, denyHost, denyOrigin, denyBrowser, denyToken, browser, authed };
}

module.exports = { loadToken, createGuard, splitHostPort, LOOPBACK };
