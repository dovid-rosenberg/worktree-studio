// The Vite wrapper Studio launches a slotted frontend with: server/slot-vite-config.mjs.
//
// What it has to get right is one sentence — the SERVED module names this slot's backend
// port while the file ON DISK keeps the base port — because the second half is the whole
// reason the wrapper exists. `applyConfigPatch` wrote the slot port into the file itself
// and never took it back, so a worktree that had once run at slot 1 kept `localhost:1339`
// forever and a plain `npm run dev` from an editor inherited it: nothing listens on 1339
// unless Studio started it, so every API call died with ERR_CONNECTION_REFUSED.
//
// The wrapper is loaded here the way Vite loads it — as a module, with the env set — and
// its exported factory is invoked to get the resolved config. The `transform` hook is
// then called directly with the ids Vite would pass, which is the same code path a real
// dev server takes without needing to run one.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const WRAPPER = path.join(import.meta.dirname, '..', 'server', 'slot-vite-config.mjs');

const AB_PORT_ENV = {
  api__port_su: 1231,
  api__port_iso: 1232,
  api__port: 1233,
  api__port_merchant: 1239,
  api__port_internal: 1999,
};

// A frontend config as they really look: several references to one backend, plus a
// same-host port that is NOT the backend's and a longer number that starts with one.
const FE_CONFIG = [
  'export default {',
  "  baseURL: 'http://localhost:1239/merchant',",
  "  su: 'http://127.0.0.1:1231/su',",
  "  verifyUrl: 'http://localhost:1239/merchant/admin/three-ds',",
  "  legacyUrl: 'http://localhost:3030/',",
  "  notAPort: 'http://localhost:12390/nope',",
  '};',
].join('\n');

/** A throwaway worktree with a base vite config and a frontend config. */
function worktree({ baseConfig = 'vite.config.js', feConfig = FE_CONFIG } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-slotvite-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'config.js'), feConfig);
  // Mirrors merchant-v3: an alias built from import.meta.url, which is exactly what
  // breaks if the wrapper ever loads this file by static absolute import (Vite inlines
  // those into its own bundle).
  fs.writeFileSync(
    path.join(dir, baseConfig),
    [
      "import { fileURLToPath, URL } from 'node:url';",
      'export default {',
      "  plugins: [{ name: 'repo-own-plugin' }],",
      "  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },",
      '  server: { port: 3030 },',
      '  build: { sourcemap: true },',
      '};',
    ].join('\n'),
  );
  return dir;
}

let nonce = 0;

/**
 * Load the wrapper with `WTS_SLOT_VITE` set and return its resolved config.
 *
 * The wrapper reads the env once at module scope, so each case needs its own module
 * instance — hence the cache-busting query. The env is restored afterwards so a failure
 * cannot leak into the next test.
 */
async function resolveConfig(payload: Record<string, unknown>, configEnv = {}) {
  const prev = process.env.WTS_SLOT_VITE;
  process.env.WTS_SLOT_VITE = JSON.stringify(payload);
  try {
    const mod = await import(`${path.toNamespacedPath(WRAPPER)}?n=${nonce++}`);
    return await mod.default(configEnv);
  } finally {
    if (prev === undefined) delete process.env.WTS_SLOT_VITE;
    else process.env.WTS_SLOT_VITE = prev;
  }
}

function payloadFor(dir: string, slot: number, extra: Record<string, unknown> = {}) {
  return {
    root: dir,
    baseConfig: path.join(dir, 'vite.config.js'),
    file: 'src/config.js',
    siblingPortEnv: AB_PORT_ENV,
    offsetStep: 100,
    maxSlots: 3,
    slot,
    ...extra,
  };
}

/** Run the wrapper's transform hook the way Vite would. */
function transform(cfg: { plugins: { name: string; transform?: Function }[] }, code: string, id: string) {
  const plugin = cfg.plugins.find((p) => p.name === 'wts:slot-port');
  assert.ok(plugin?.transform, 'wrapper must contribute a wts:slot-port transform');
  return plugin.transform!(code, id);
}

test('the served module names the slot port while the file on disk keeps the base port', async () => {
  const dir = worktree();
  const cfg = await resolveConfig(payloadFor(dir, 1));
  const target = path.join(dir, 'src', 'config.js');

  const out = transform(cfg, FE_CONFIG, target);
  assert.match(out.code, /localhost:1339\/merchant/, 'served module is on slot 1');
  assert.match(out.code, /127\.0\.0\.1:1331\/su/, 'every family member moves together');

  // The half that the old on-disk rewrite got wrong.
  assert.equal(
    fs.readFileSync(target, 'utf8'),
    FE_CONFIG,
    'the file on disk must be byte-for-byte unchanged — a vanilla `npm run dev` reads it',
  );
});

test('ports outside the backend families are left alone', async () => {
  const dir = worktree();
  const cfg = await resolveConfig(payloadFor(dir, 1));
  const out = transform(cfg, FE_CONFIG, path.join(dir, 'src', 'config.js'));
  assert.match(out.code, /localhost:3030\//, "the frontend's own port is not a backend port");
  assert.match(out.code, /localhost:12390\/nope/, 'the trailing-digit guard still holds');
});

test('slot 0 is a no-op and transforms nothing', async () => {
  const dir = worktree();
  const cfg = await resolveConfig(payloadFor(dir, 0));
  assert.equal(
    transform(cfg, FE_CONFIG, path.join(dir, 'src', 'config.js')),
    null,
    'an unchanged module must be returned as null, not as an identical rewrite',
  );
});

test('only the configured file is eligible, by absolute path', async () => {
  const dir = worktree();
  const cfg = await resolveConfig(payloadFor(dir, 1));
  // A same-named file elsewhere in the graph — e.g. inside a dependency — must not match.
  assert.equal(transform(cfg, FE_CONFIG, path.join(dir, 'node_modules', 'x', 'src', 'config.js')), null);
  assert.equal(transform(cfg, FE_CONFIG, path.join(dir, 'src', 'other.js')), null);
});

test('a query suffix on the id still matches the target', async () => {
  const dir = worktree();
  const cfg = await resolveConfig(payloadFor(dir, 2));
  // Vite appends `?v=…` / `?import` to ids; the file is whatever precedes the `?`.
  const out = transform(cfg, FE_CONFIG, `${path.join(dir, 'src', 'config.js')}?v=abc123`);
  assert.ok(out, 'a suffixed id is the same module');
  assert.match(out.code, /localhost:1439\/merchant/);
});

test('the base config is preserved and the slot port applied over it', async () => {
  const dir = worktree();
  const cfg = await resolveConfig(payloadFor(dir, 1, { port: 3130 }));
  assert.equal(cfg.root, dir, 'root must be set — the config lives outside the project');
  assert.equal(cfg.server.port, 3130, "Studio owns the port; the repo's 3030 is overridden");
  assert.deepEqual(cfg.build, { sourcemap: true }, 'unrelated base settings survive');
  // realpath both sides: on macOS os.tmpdir() is `/var/...` while the base config, which
  // builds its alias from its own import.meta.url, resolves to `/private/var/...`.
  assert.ok(
    fs.realpathSync(cfg.resolve.alias['@']).startsWith(fs.realpathSync(dir)),
    'the alias resolves against the REPO, not Studio — proof the base config was loaded as its own module',
  );
  assert.equal(cfg.plugins[0].name, 'repo-own-plugin', "the repo's own plugins come first");
  assert.equal(cfg.plugins.at(-1).name, 'wts:slot-port');
});

test('a base config exporting a function is unwrapped and given the vite env', async () => {
  const dir = worktree();
  fs.writeFileSync(
    path.join(dir, 'vite.config.js'),
    'export default async ({ command, mode }) => ({ server: { port: 3030 }, __seen: { command, mode } });',
  );
  const cfg = await resolveConfig(payloadFor(dir, 1, { port: 3130 }), {
    command: 'serve',
    mode: 'development',
  });
  assert.deepEqual(cfg.__seen, { command: 'serve', mode: 'development' }, 'env passes through');
  assert.equal(cfg.server.port, 3130);
});

test('without WTS_SLOT_VITE the wrapper refuses to load rather than serving a wrong port', async () => {
  const prev = process.env.WTS_SLOT_VITE;
  delete process.env.WTS_SLOT_VITE;
  try {
    await assert.rejects(
      () => import(`${path.toNamespacedPath(WRAPPER)}?n=${nonce++}`),
      /WTS_SLOT_VITE/,
      'this config is Studio-launched only; silently serving the base port would hide that',
    );
  } finally {
    if (prev !== undefined) process.env.WTS_SLOT_VITE = prev;
  }
});
