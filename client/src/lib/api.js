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
 * The boot token. `app.html` declares `window.WTS_TOKEN = "__WTS_TOKEN__"` and the
 * daemon substitutes the real value when it serves the document — the same mechanism
 * `public/index.html` already uses, so the built SPA needs no new server code path
 * beyond pointing the existing injector at `client/build/index.html`.
 *
 * In dev the document is served by Vite, which does the substitution itself (see the
 * `wtsToken` plugin in vite.config.js). An UNsubstituted placeholder means neither
 * happened; treat it as absent so the failure is a clean 401 rather than a token that
 * is silently wrong.
 */
export const TOKEN = (() => {
  const t = typeof window !== 'undefined' ? /** @type {any} */ (window).WTS_TOKEN : '';
  return !t || t === '__WTS_TOKEN__' ? '' : String(t);
})();

/**
 * `?token=…` / `&token=…` for EventSource and WebSocket URLs.
 * @param {'?'|'&'} sep
 */
export const tokenQuery = (sep) => (TOKEN ? `${sep}token=${encodeURIComponent(TOKEN)}` : '');

/**
 * A JSON call to the daemon. Throws `Error(data.error || statusText)` on a non-2xx so
 * callers can `try { … } catch (e) { toast(e.message, true) }` exactly as app.js did.
 *
 * @param {'GET'|'POST'|'DELETE'|'PUT'} method
 * @param {string} url
 * @param {unknown} [body]
 * @returns {Promise<any>}
 */
export async function api(method, url, body) {
  /** @type {RequestInit & { headers: Record<string,string> }} */
  const opt = { method, headers: { 'x-wts-token': TOKEN } };
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
 *
 * @template T
 * @param {(v: boolean) => void} setBusy
 * @param {() => Promise<T>} fn
 */
export async function busy(setBusy, fn) {
  setBusy(true);
  try { return await fn(); }
  finally { setBusy(false); }
}
