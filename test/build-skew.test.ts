/*
 * Build skew: the daemon process versus the bundle on disk.
 *
 * The daemon serves client/build straight from disk, so rebuilding the frontend swaps
 * the UI under a running process without restarting it. That is normally what you want —
 * but a bundle newer than the daemon calls routes the daemon has never registered, and
 * the user sees Express's default HTML 404 with nothing connecting it to the cause.
 *
 * This pins the one fact that makes the difference detectable: what the daemon booted
 * with, versus what it is serving right now.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import * as webui from '../server/webui.ts';

const TOKEN = 'a'.repeat(64);
const SHELL = (extra = '') =>
  `<!doctype html><html><head><script>window.WTS_TOKEN = "${webui.PLACEHOLDER}";` +
  `window.WTS_BUILD = "${webui.BUILD_PLACEHOLDER}";</script>${extra}</head><body>app</body></html>`;

function fixture(client: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-skew-'));
  fs.mkdirSync(path.join(root, 'client', 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'client', 'build', 'index.html'), client);
  return root;
}

async function serving<T>(app: express.Express, fn: (get: (p: string) => Promise<Response>) => Promise<T>) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as import('net').AddressInfo).port}`;
  try {
    return await fn((p) => fetch(base + p, { headers: { 'x-wts-token': TOKEN } }));
  } finally {
    server.close();
  }
}

test('buildId is stable for unchanged bundle contents and changes when they change', () => {
  const root = fixture(SHELL());
  const index = path.join(root, 'client', 'build', 'index.html');
  const a = webui.buildId(index);
  assert.match(a, /^[0-9a-f]{12}$/, 'a short hex digest, cheap to compare and to eyeball');
  assert.equal(webui.buildId(index), a, 'same bytes, same id');

  fs.writeFileSync(index, SHELL('<link rel="stylesheet" href="/_app/x.9f2c1.css">'));
  assert.notEqual(webui.buildId(index), a, 'a rebuild rewrites hashed asset URLs, so the id must move');
});

test('a missing bundle yields an empty id rather than throwing', () => {
  assert.equal(webui.buildId('/nope/index.html'), '', 'boot must not die because the build is absent');
});

test('the served document carries the id of the bundle on disk right now', async () => {
  const root = fixture(SHELL());
  const index = path.join(root, 'client', 'build', 'index.html');
  const ui = webui.resolve(root);
  const app = express();
  // The daemon booted with whatever was on disk then.
  const bootId = webui.buildId(index);
  webui.mount(app, { ui, token: TOKEN, bootBuildId: bootId });

  await serving(app, async (get) => {
    const first = await (await get('/')).text();
    assert.ok(first.includes(bootId), 'before any rebuild the two agree');
    assert.ok(!first.includes(webui.BUILD_PLACEHOLDER), 'the placeholder must be substituted');

    // Somebody runs `npm run build` while the daemon keeps running.
    fs.writeFileSync(index, SHELL('<link rel="stylesheet" href="/_app/x.deadbe.css">'));
    const after = await (await get('/')).text();
    const nowId = webui.buildId(index);
    assert.ok(after.includes(nowId), 'the document reports the bundle it actually is');
    assert.ok(!after.includes(bootId), 'and no longer the one the daemon booted with');
    assert.notEqual(nowId, bootId, 'which is exactly the skew the client compares for');
  });
});
