/*
 * The one place that knows how to talk to the daemon.
 *
 * Every /api request has to carry the boot token (server/security.js). It goes in a
 * header where we can set one, and in the query string on the two transports that
 * cannot — EventSource and WebSocket. Requests also pass an Origin/Host allowlist,
 * which is why dev traffic goes through the Vite proxy on the same origin rather than
 * straight at 127.0.0.1:7803.
 */

/**
 * The boot token.
 *
 * PRODUCTION: `app.html` declares `window.WTS_TOKEN` with a placeholder, and the daemon
 * substitutes the real value when it serves the document — the same mechanism
 * `public/index.html` already uses, so the built SPA needs no new server code path
 * beyond pointing the existing injector at `client/build/index.html`.
 *
 * DEV: there is no daemon in front of the document (Vite serves it), so the placeholder
 * would survive. Vite `define`s the token instead, and only for `serve` — on a build the
 * identifier below is statically replaced with `''`, so a token can never be written
 * into the built output.
 *
 * An unsubstituted placeholder with no dev value means neither path ran; treat it as
 * absent so the failure is a clean 401 rather than a token that is silently wrong.
 */
export const TOKEN: string = (() => {
  const injected = typeof window !== 'undefined' ? (window as unknown as { WTS_TOKEN?: string }).WTS_TOKEN : '';
  if (injected && !/^__WTS_TOKEN/.test(injected)) return String(injected);
  return String(import.meta.env.VITE_WTS_TOKEN || '');
})();

/** `?token=…` / `&token=…` for EventSource and WebSocket URLs. */
export const tokenQuery = (sep: '?' | '&'): string => (TOKEN ? `${sep}token=${encodeURIComponent(TOKEN)}` : '');

/**
 * A JSON call to the daemon. Throws `Error(data.error || statusText)` on a non-2xx so
 * callers can `try { … } catch (e) { toast(e.message, true) }` exactly as app.js did.
 *
 * The return stays `any`: every endpoint answers a different shape and the call sites
 * narrow it themselves. Promising something more specific here would be a lie that
 * only moves the cast.
 */
export type HttpMethod = 'GET' | 'POST' | 'DELETE';

export interface RequestOpts {
  body?: unknown;
  /** Search fires per keystroke; without this a slow query lands after a fast one. */
  signal?: AbortSignal;
  /**
   * Throw on a 200 whose body is not JSON. The SPA fallback serves index.html for a
   * mistyped path, so a panel that renders whatever it got would render the app into
   * itself. Off by default: `api()` has always tolerated it as `{ raw }`.
   */
  strictJson?: boolean;
}

/**
 * THE call to the daemon. Auth, parsing and error shape, once.
 *
 * There were three of these — this one, `insights/api.ts` and `review/api.ts` — each
 * re-implementing token headers, text→JSON and non-2xx→Error, and they had already
 * drifted: the review copy read `globalThis.WTS_TOKEN` with none of the placeholder
 * guards below, so in dev it sent the literal `__WTS_TOKEN__` and every call 401'd.
 * Those two modules keep their typed endpoint wrappers, which is their real job, and
 * call this for the transport.
 *
 * The return stays `any`: every endpoint answers a different shape and the call sites
 * narrow it themselves. Promising something more specific here would be a lie that only
 * moves the cast.
 */
export async function request(method: HttpMethod, url: string, opts: RequestOpts = {}): Promise<any> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (TOKEN) headers['x-wts-token'] = TOKEN;
  const init: RequestInit = { method, headers, signal: opts.signal };
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    // An abort is the caller's own doing and must stay distinguishable.
    if (e instanceof Error && e.name === 'AbortError') throw e;
    // The daemon being down is the common case, and `TypeError: Failed to fetch` is not
    // something to put in front of a user.
    throw new Error('Cannot reach the Worktree Studio daemon.');
  }

  const txt = await res.text();
  let data: any;
  let parsed = true;
  try { data = txt ? JSON.parse(txt) : {}; } catch { parsed = false; data = { raw: txt }; }
  if (!res.ok) throw new Error(data?.error || res.statusText || `HTTP ${res.status}`);
  if (opts.strictJson && !parsed) throw new Error('The daemon returned a non-JSON response.');
  return data;
}

/** The mutating shorthand the shell uses everywhere: `api('POST', url, body)`. */
export function api(method: HttpMethod, url: string, body?: unknown): Promise<any> {
  return request(method, url, body === undefined ? {} : { body });
}

/**
 * Run an async action with a visible "in flight" flag, guaranteeing the flag clears.
 * Replaces app.js's guardBtn(), which disabled a DOM node directly; here the caller
 * owns a `$state` boolean and binds it to `disabled`.
 */
export async function busy<T>(setBusy: (v: boolean) => void, fn: () => Promise<T>): Promise<T> {
  setBusy(true);
  try { return await fn(); }
  finally { setBusy(false); }
}
