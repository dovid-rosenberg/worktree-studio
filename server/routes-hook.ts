// The Claude Code hook receiver: the one route on this daemon that is NOT under /api.
//
// The URL is baked into every session's generated settings file. Those files are read
// once, at claude's launch — so a session that was already running when a new build
// started still POSTs a tokenless URL and cannot be told otherwise without killing it.
// `hookAuth` marks the sessions whose settings file we have since written *with* a
// token; anything else is grandfathered in. The exemption is narrow (this route only
// sets a session's state/activity string) and self-clearing (activate/restore rewrites
// the file and sets the flag).
//
// Registered against the APP, not the /api router, and deliberately so — which is why it
// takes `denyToken` rather than sitting behind the `guard.authed` middleware that covers
// the /api prefix. test/app-surface.test.ts asserts that this, and nothing else, is the
// unauthenticated hole in the mounted surface.
import type { Router } from 'express';
import type { Denial, GuardedRequest } from './security.ts';
import type { HookBody } from './sessions.ts';

/** A session, as the receiver reads it: only the grandfathering flag matters here. */
interface HookSession {
  hookAuth?: boolean;
}

/** The token check, in the `null to allow / a denial to refuse` shape security.ts uses. */
type DenyToken = (req: GuardedRequest) => Denial | null;

interface HookDeps {
  manager: {
    get(id: string): HookSession | null | undefined;
    applyHook(id: string, event: string, payload?: HookBody | null): void;
  };
  /** `guard.denyToken` — see server/security.ts. */
  denyToken: DenyToken;
}

function register(app: Router, { manager, denyToken }: HookDeps): void {
  app.post('/hook/:event', (req, res) => {
    // `?wts=a&wts=b` (or `?wts[x]=y`) hands express an array/object, not a string —
    // same hazard transcript-routes.ts collapses for its query params. Here it made
    // the lookup miss and the hook get dropped in silence. Collapse to the first
    // value, which is what a client sending one session id meant.
    const raw = req.query.wts;
    const id = raw == null ? '' : String(Array.isArray(raw) ? raw[0] : raw);
    const known = id ? manager.get(id) : null;
    const deny = denyToken(req);
    if (deny && !(known && known.hookAuth !== true))
      return res.status(deny.status).json({ error: deny.error });
    let payload = req.body;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = { raw: payload };
      }
    }
    /*
     * A dropped hook says so. This answered ok:true for an empty or unknown `wts`, which
     * is indistinguishable from an applied one — the exact failure mode the array
     * coercion just above was added to fix, left in place one line further down. The
     * session's state simply stops updating and nothing anywhere says why.
     *
     * Still a 200: the hook runs inside the user's claude process and a non-2xx there is
     * noise in their terminal for a condition they cannot act on mid-session. `applied`
     * is for the log and for anyone debugging a card that has gone quiet.
     */
    if (!known) {
      console.warn(
        `[wt-studio] hook ${req.params.event} dropped: ${id ? `unknown session ${id}` : 'no session id'}`,
      );
      return res.json({ ok: true, applied: false, reason: id ? 'unknown session' : 'no session id' });
    }
    manager.applyHook(id, req.params.event, payload || {});
    res.json({ ok: true, applied: true });
  });
}

export { register };
