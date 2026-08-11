// Reading back what applyConfigPatch wrote: which backend a frontend worktree's
// gitignored config actually points at, and whose backend that is.
//
// The gap this covers is a real incident. applyConfigPatch has always been write-only —
// it rewrites the FE config to this feature's slot ports and nothing ever reads the file
// again, nor reverts it on stop. So a config could say `localhost:1439` while the process
// on 1439 belonged to a different feature on a different branch, and every surface in the
// app reported green: `POST /merchant/api/totp/600/register` came back 404 from a checkout
// that has no such route, and the day went into the 404.
//
// Real temp worktrees and real config files throughout (the idiom in
// concurrency-wiring.test.ts). The one thing that cannot be real is the discovery map:
// discoverRunning() shells out to lsof, so the tests hand `wiredTo` the same
// Map(realpath → {pid,ports}) it would have produced. That map's construction is covered
// in servers.test.ts; what is under test here is the resolution on top of it.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Servers, realpath } from '../server/servers.ts';
import type { RunningServer } from '../server/servers.ts';
import { present } from './helpers.ts';

// accept-blue's real port map + the FE configPatch wiring — same fixture as
// concurrency-wiring.test.ts, so both sides of the read/write pair are exercised
// against one port map.
const AB_PORT_ENV = {
  api__port_su: 1231,
  api__port_iso: 1232,
  api__port: 1233,
  api__port_merchant: 1239,
  api__port_internal: 1999,
};

function servers(concOverrides = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-wired-'));
  return new Servers({
    _stateDir: stateDir,
    web: { port: 0 },
    start: {},
    concurrency: {
      enabled: true,
      offsetStep: 100,
      maxSlots: 3,
      repos: {
        'accept-blue': { portEnv: { ...AB_PORT_ENV }, slotEnv: ['redis__db'] },
        'merchant-v3': {
          portEnv: { WTS_FE_PORT: 3030 },
          configPatch: { file: 'src/config.ts', siblingRepo: 'accept-blue' },
        },
        // A repo in the concurrency map with no configPatch at all: the control for
        // "never flagged".
        'plain-fe': { portEnv: { PLAIN_PORT: 4040 } },
      },
      ...concOverrides,
    },
  });
}

const FE_CONFIG = [
  'export default {',
  "  suURL: 'http://localhost:1231/su/api/v1',",
  "  merchantURL: 'http://localhost:1239/merchant',",
  "  isoURL: 'http://localhost:1232/iso/api/v1',",
  "  fePort: 'http://localhost:3030',",
  '};',
  '',
].join('\n');

// A worktree directory named like a feature's, with an FE config already patched to
// `slot`. Named under a `.worktrees/<feature>` path because that is what featureFor()
// reads: the nested layout's segment after the container dir.
function feWorktree(feature: string, slot: number, contents = FE_CONFIG) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-repo-'));
  const dir = path.join(repoRoot, '.worktrees', feature);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/config.ts'), contents);
  // Patch through the real writer, so what the reader reads back is what the writer
  // actually produces rather than a hand-typed guess at it. That pairing is the whole
  // point of the feature: the two must not be able to disagree about what a reference
  // to a backend looks like.
  patcher().applyConfigPatch(dir, { file: 'src/config.ts', siblingPortEnv: AB_PORT_ENV, slot });
  return { path: dir, repo: 'merchant-v3' };
}

// A Servers used only for its applyConfigPatch — the writer half, kept separate from
// the instance under test so the fixture cannot accidentally warm its read cache.
let _patcher: Servers | null = null;
function patcher(): Servers {
  _patcher ||= servers();
  return _patcher;
}

// A backend worktree of `feature` listening on `ports`, as discoverRunning() would
// report it. Its directory need only exist for realpath() to resolve.
function backend(feature: string, ports: number[]): [string, RunningServer] {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-be-'));
  const dir = path.join(repoRoot, '.worktrees', feature);
  fs.mkdirSync(dir, { recursive: true });
  return [realpath(dir), { pid: 4242, ports }];
}

function running(...entries: [string, RunningServer][]) {
  return new Map<string, RunningServer>(entries);
}

// ---------------------------------------------------------------------------
// the three real states
// ---------------------------------------------------------------------------

test("a frontend patched to its own feature's backend reads as correctly wired", () => {
  const s = servers();
  const fe = feWorktree('mfa', 1); // slot 1 → the 13xx/20xx family
  const w = s.wiredTo(fe, running(backend('mfa', [1339, 1331])));
  const wired = present(w, 'a wiredTo verdict');
  assert.equal(wired.status, 'mine');
  assert.equal(wired.feature, 'mfa');
  assert.ok(wired.ports.includes(1339), `slot-1 merchant port is referenced: ${wired.ports}`);
  assert.ok(wired.port !== null && wired.ports.includes(wired.port), 'the verdict names one of them');
});

test('a frontend patched to a port held by ANOTHER feature is flagged, and names that feature', () => {
  const s = servers();
  // The incident, reproduced: the FE is patched to slot 2 (…1439), and the process
  // holding 1439 is a worktree of a completely different feature.
  const fe = feWorktree('mfa', 2);
  const wired = present(s.wiredTo(fe, running(backend('billing-refactor', [1439]))), 'a wiredTo verdict');
  assert.equal(wired.status, 'foreign');
  assert.equal(wired.port, 1439);
  assert.equal(wired.feature, 'billing-refactor', 'the other feature is NAMED — that is the point');
  assert.ok(wired.path?.endsWith('/billing-refactor'), 'and locatable on disk');
});

test('a foreign backend outranks a matching one: a half-wired config is still wrong', () => {
  const s = servers();
  const fe = feWorktree('mfa', 2); // references 1431, 1432, 1433, 1439, 2199
  // Our own backend holds one of the ports, a stranger holds another. Reporting the
  // good half would hide the call that goes to the wrong branch.
  const wired = present(
    s.wiredTo(fe, running(backend('mfa', [1431]), backend('billing-refactor', [1439]))),
    'a wiredTo verdict',
  );
  assert.equal(wired.status, 'foreign');
  assert.equal(wired.feature, 'billing-refactor');
});

test('a frontend patched to a port nothing is listening on is reported as dead, not as fine', () => {
  const s = servers();
  const fe = feWorktree('mfa', 1);
  const wired = present(s.wiredTo(fe, running()), 'a wiredTo verdict');
  assert.equal(wired.status, 'dead');
  assert.equal(wired.feature, null);
  assert.equal(wired.path, null);
  assert.ok(wired.port !== null, 'it still says WHERE it is pointed');
});

// ---------------------------------------------------------------------------
// never flagged / degrades to null
// ---------------------------------------------------------------------------

test('a repo with no configPatch is never flagged, even with an FE config sitting there', () => {
  const s = servers();
  const fe = feWorktree('mfa', 2);
  const plain = { path: fe.path, repo: 'plain-fe' }; // same file on disk, different repo
  assert.equal(s.wiredTo(plain, running(backend('billing-refactor', [1439]))), null);
  assert.equal(s.wiredPorts(plain), null);
});

test('a repo outside concurrency.repos entirely is never flagged', () => {
  const s = servers();
  const fe = feWorktree('mfa', 2);
  assert.equal(s.wiredTo({ path: fe.path, repo: 'not-configured' }, running()), null);
});

test('with concurrency disabled nothing is read and nothing is flagged', () => {
  const s = servers({ enabled: false });
  const fe = feWorktree('mfa', 2);
  assert.equal(s.wiredTo(fe, running(backend('billing-refactor', [1439]))), null);
});

test('an absent config file degrades to null rather than throwing', () => {
  const s = servers();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-empty-'));
  const fe = { path: dir, repo: 'merchant-v3' };
  assert.doesNotThrow(() => s.wiredTo(fe, running()));
  assert.equal(s.wiredTo(fe, running()), null, 'no file is "I did not look", not a verdict');
});

test('an unreadable config file degrades to null rather than throwing', (t) => {
  if (process.getuid?.() === 0) return t.skip('root can read anything');
  const s = servers();
  const fe = feWorktree('mfa', 1);
  fs.chmodSync(path.join(fe.path, 'src/config.ts'), 0o000);
  try {
    assert.doesNotThrow(() => s.wiredTo(fe, running()));
    assert.equal(s.wiredTo(fe, running()), null);
  } finally {
    fs.chmodSync(path.join(fe.path, 'src/config.ts'), 0o644);
  }
});

test('a config naming no backend of the sibling repo is "unknown", not a verdict', () => {
  const s = servers();
  // Reads fine; simply contains nothing from accept-blue's port families. Distinct from
  // null (did not look) and from dead (points somewhere, nothing there).
  const fe = feWorktree('mfa', 0, "export default { suURL: 'https://api.example.com' };\n");
  const wired = present(s.wiredTo(fe, running()), 'a wiredTo verdict');
  assert.equal(wired.status, 'unknown');
  assert.deepEqual(wired.ports, []);
  assert.equal(wired.port, null);
});

// ---------------------------------------------------------------------------
// the read itself
// ---------------------------------------------------------------------------

test('wiredPorts reads back exactly the family applyConfigPatch wrote', () => {
  const s = servers();
  const fe = feWorktree('mfa', 2);
  // slot 2 of the three families the fixture config references (su/merchant/iso).
  // The FE's own vite port (3030) is not accept-blue's, so it must not appear.
  assert.deepEqual(s.wiredPorts(fe), [1431, 1432, 1439]);
});

test('a hand-edited config is seen on the next read — the parse is keyed on the file, not cached forever', () => {
  const s = servers();
  const fe = feWorktree('mfa', 0);
  assert.deepEqual(s.wiredPorts(fe), [1231, 1232, 1239]);
  const file = path.join(fe.path, 'src/config.ts');
  // Same length, different digits: a cache keyed on size alone would miss this, which
  // is why the stamp carries mtime too.
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('1239').join('1439'));
  assert.deepEqual(s.wiredPorts(fe), [1231, 1232, 1439], 'the edit is visible');
});

test('decorate carries the verdict on the Worktree row, so /api/state emits it without a new route', () => {
  const s = servers();
  const fe = feWorktree('mfa', 2);
  const d = s.decorate(fe, running(backend('billing-refactor', [1439])));
  assert.equal(present(d.wiredTo, 'wiredTo on the decoration').status, 'foreign');
});

test('a worktree whose directory is gone carries no verdict', () => {
  const s = servers();
  const fe = feWorktree('mfa', 2);
  fs.rmSync(fe.path, { recursive: true, force: true });
  assert.equal(s.decorate(fe, running()).wiredTo, null);
});
