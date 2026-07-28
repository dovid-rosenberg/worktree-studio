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
export type HttpMethod = 'GET' | 'POST' | 'DELETE' | 'PUT';

export async function api(method: HttpMethod, url: string, body?: unknown): Promise<any> {
  const opt: RequestInit & { headers: Record<string, string> } =
    { method, headers: { 'x-wts-token': TOKEN } };
  if (body !== undefined) {
    opt.headers['content-type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(url, opt);
  const txt = await res.text();
  let data;
  try { data = txt ? JSON.parse(txt) : {}; } catch { data = { raw: txt }; }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
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
