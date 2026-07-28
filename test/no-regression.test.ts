// The one test that has to hold: with the owner's CURRENT config — a config that
// names none of the new keys — nothing about feature grouping, concurrency slot
// keying or worktree creation changes.
//
// It is a differential test. The three functions the old code used are
// reimplemented verbatim below (they were four lines each), and every new code
// path is asserted equal to them over a corpus of realistic worktrees. That is
// stronger than asserting known-good values, because it fails if either side
// drifts.
//
// The config literal is a COPY of the owner's config.json shape, checked in here.
// Nothing in this file reads or writes ~/.config/worktree-studio.
import { test } from 'node:test';
import assert from 'node:assert';
import { present } from './helpers.ts';
import type { GroupConfig, Worktree } from '../server/types.ts';
import path from 'path';
import os from 'os';
import fs from 'fs';

import { createIdentity } from '../server/identity.ts';
import * as layoutMod from '../server/layout.ts';
import { computeFeatures } from '../server/features.ts';
import { Servers, featureFromPath } from '../server/servers.ts';
import * as worktree from '../server/worktree.ts';

// ---------------------------------------------------------- the old code ----

// server/servers.ts before this change.
function oldFeatureFromPath(worktreePath: string): string {
  const parts = String(worktreePath || '').split(path.sep);
  const i = parts.lastIndexOf('.worktrees');
  return (i >= 0 && parts[i + 1]) ? parts[i + 1] : path.basename(worktreePath || '');
}

// server/features.ts before this change: the grouping key was the bare wtname.
const oldGroupKey = (w: Worktree) => w.wtname;

// server/worktree.ts before this change.
const oldDest = (repoPath: string, wtName: string) => path.join(repoPath, '.worktrees', wtName);

// -------------------------------------------------- the owner's config shape --

// Copied from ~/.config/worktree-studio/config.json. Note what it does NOT
// contain: `worktrees`, `featureIdentity`, `copyAlways`, `concurrency`, `groups`.
const OWNER_CONFIG = {
  baseDirs: ['~/Desktop/ab-code'],
  scanDepth: 3,
  web: { port: 7788, host: '127.0.0.1' },
  multiplexer: 'auto',
  claude: { cmd: 'claude' },
  editors: {
    WebStorm: { open: 'open -na WebStorm --args {path}' },
    Zed: { open: '/Applications/Zed.app/Contents/MacOS/cli {path}', openGroup: '/Applications/Zed.app/Contents/MacOS/cli {paths}' },
    Fleet: { open: 'open -na Fleet --args {path}' },
  },
  defaultEditor: 'WebStorm',
  copyPatterns: { default: ['.env', '.env.local', '.env.*.local', 'config/*-config.ts'] },
  start: {
    'accept-blue': { cmd: 'node app.js', ports: [1231, 1232, 1233, 1239, 1999] },
    'merchant-v3': { cmd: 'npm run dev', ports: [3030] },
    'ab-iso-fe': 'npm start',
  },
  popout: { terminal: 'Terminal' },
  sources: { github: { enabled: true }, gitlab: { enabled: false }, asana: { enabled: false } },
};

// A corpus that mirrors the real thing: main checkouts, a feature spanning three
// repos, singles, an odd name, a deep path, a detached worktree.
const BASE = '/Users/davidr/Desktop/ab-code';
// A worktree row spelling only what the functions under comparison read; the rest of
// `Worktree` plays no part in grouping or slotting.
const wt = (repo: string, repoDir: string, name: string, branch: string | null, extra: Partial<Worktree> = {}) => ({
  repo,
  wtname: name,
  branch,
  path: name === repo ? `${BASE}/${repoDir}/${repo}` : `${BASE}/${repoDir}/${repo}/.worktrees/${name}`,
  running: false,
  ...extra,
} as Worktree);

const CORPUS = [
  wt('accept-blue', 'ab-be', 'accept-blue', 'develop'),
  wt('merchant-v3', 'ab-merchant', 'merchant-v3', 'main'),
  wt('ab-iso-fe', 'ab-iso', 'ab-iso-fe', 'main'),
  wt('ab-su', 'ab-su', 'ab-su', 'main'),
  // one feature across three repos (identical basenames — the owner's convention)
  wt('accept-blue', 'ab-be', 'custom-reports', 'feature/custom-reports'),
  wt('merchant-v3', 'ab-merchant', 'custom-reports', 'feature/custom-reports'),
  wt('ab-su', 'ab-su', 'custom-reports', 'feature/custom-reports'),
  // singles
  wt('accept-blue', 'ab-be', 'fix-recurring-deleted-pm', 'fix/recurring-deleted-pm'),
  wt('merchant-v3', 'ab-merchant', 'merchant-mfa', 'feature/merchant-mfa'),
  // a name that is not derived from its branch, and a detached one
  wt('ab-iso-fe', 'ab-iso', 'wip', 'chore/some-unrelated-branch'),
  wt('accept-blue', 'ab-be', 'detached', null, { detached: true }),
];

const identity = createIdentity(OWNER_CONFIG);

// ---------------------------------------------------------------- identity --

test("the owner's config resolves to the historical layout and strategy", () => {
  assert.equal(identity.strategy, 'basename');
  assert.equal(identity.warning, null, 'no config warning is emitted');
  assert.deepEqual(identity.layout, { mode: 'nested', dir: '.worktrees', root: '' });
});

test('slot keying is byte-identical to the old featureFromPath() over the whole corpus', () => {
  for (const w of CORPUS) {
    assert.equal(identity.ofPath(w.path), oldFeatureFromPath(w.path), `differs for ${w.path}`);
  }
});

test('slot keying is still identical after the scan index is fed', () => {
  const repos: Array<{ name: string; worktrees: Array<{ path: string; name: string; branch: string | null }> }> = [];
  for (const w of CORPUS) {
    let r = repos.find((x) => x.name === w.repo);
    if (!r) { r = { name: w.repo, worktrees: [] }; repos.push(r); }
    r.worktrees.push({ path: w.path, name: w.wtname, branch: w.branch });
  }
  identity.reindex(repos);
  for (const w of CORPUS) assert.equal(identity.ofPath(w.path), oldFeatureFromPath(w.path));
});

test('slot keying matches the old function for the awkward paths too', () => {
  const odd = [
    `${BASE}/ab-be/accept-blue/.worktrees/feat/src/lib`, // a cwd deep inside a worktree
    `${BASE}/ab-be/accept-blue`,                          // main checkout
    `${BASE}/ab-be/accept-blue/.worktrees`,               // the container itself
    '/private/tmp/somewhere/else',                        // nothing to do with a repo
    '',
  ];
  for (const p of odd) {
    assert.equal(identity.ofPath(p), oldFeatureFromPath(p), `differs for "${p}"`);
    assert.equal(featureFromPath(p), oldFeatureFromPath(p), `the free function differs for "${p}"`);
  }
});

test('grouping keys are byte-identical to the old wtname key', () => {
  for (const w of CORPUS) assert.equal(identity.of(w), oldGroupKey(w), `differs for ${w.repo}/${w.wtname}`);
});

// ------------------------------------------------ grouping AND slotting agree --

test('grouping and slot keying give the same answer for every worktree', () => {
  for (const w of CORPUS) {
    assert.equal(identity.of(w), identity.ofPath(w.path),
      `grouping and slotting disagree for ${w.path} — a feature grouped one way and slotted another collides on ports`);
  }
});

test("computeFeatures under the owner's config equals grouping by wtname", () => {
  const { features, groups } = computeFeatures(CORPUS, (OWNER_CONFIG as { groups?: GroupConfig[] }).groups || [], identity);

  // rebuild what the old code produced, from the old key
  const expected = new Map<string, Worktree[]>();
  for (const w of CORPUS.filter((x) => x.wtname !== x.repo)) {
    if (!expected.has(oldGroupKey(w))) expected.set(oldGroupKey(w), []);
    present(expected.get(oldGroupKey(w))).push(w);
  }
  assert.deepEqual(features.map((f) => f.name).sort(), [...expected.keys()].sort());
  for (const f of features) {
    assert.deepEqual(
      f.members.map((m) => (m.missing ? m.ref : m.path)).sort(),
      present(expected.get(f.name), `expected members for ${f.name}`).map((m) => m.path).sort(),
      f.name,
    );
  }
  // groups are only the multi-member ones
  assert.deepEqual(groups.map((g) => g.name).sort(),
    [...expected].filter(([, m]) => m.length >= 2).map(([n]) => n).sort());
  assert.deepEqual(groups.map((g) => g.name), ['custom-reports'], 'the three-repo feature, and only it');
});

test('main checkouts are still never features', () => {
  const { features } = computeFeatures(CORPUS, [], identity);
  for (const name of ['accept-blue', 'merchant-v3', 'ab-iso-fe', 'ab-su']) {
    assert.equal(features.some((f) => f.name === name), false, `${name} leaked in as a feature`);
  }
});

// --------------------------------------------------------- worktree creation --

test('worktree creation resolves to the same destination as before', () => {
  const layout = layoutMod.resolve(OWNER_CONFIG);
  for (const repoPath of [`${BASE}/ab-be/accept-blue`, `${BASE}/ab-merchant/merchant-v3`]) {
    for (const name of ['custom-reports', 'fix-recurring-deleted-pm', 'a-b-c']) {
      assert.equal(layoutMod.destFor(layout, repoPath, name), oldDest(repoPath, name));
    }
  }
  assert.equal(layoutMod.ignorePath(layout), '.worktrees', 'the gitignore warning still checks .worktrees');
});

test("the owner's copyPatterns still reach create(), and run configs are still copied", () => {
  const opts = worktree.worktreeCopyOpts(OWNER_CONFIG, 'accept-blue');
  for (const p of OWNER_CONFIG.copyPatterns.default) {
    assert.ok(opts.copyPatterns.includes(p), `lost ${p}`);
  }
  assert.deepEqual(opts.copyAlways, ['.idea/runConfigurations/*.xml'],
    'no copyAlways key in the config → the historical unconditional JetBrains copy');
});

// ------------------------------------------------- concurrency slot registry --

test('the Servers slot registry keys on the same feature names as before', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-noreg-'));
  const cfg = {
    ...OWNER_CONFIG,
    _stateDir: stateDir,
    concurrency: { enabled: true, offsetStep: 100, maxSlots: 3, repos: { 'accept-blue': { portEnv: { api__port: 1233 }, slotEnv: ['redis__db'] } } },
  };
  const servers = new Servers(cfg, createIdentity(cfg));
  const feature = CORPUS.filter((w) => w.wtname === 'custom-reports');
  assert.equal(feature.length, 3);
  // all three repos of one feature key the same slot — one allocation, not three
  const keys = feature.map((m) => servers.featureFor(m.path));
  assert.deepEqual(keys, ['custom-reports', 'custom-reports', 'custom-reports']);
  assert.deepEqual(keys, feature.map((m) => oldFeatureFromPath(m.path)));
  for (const k of keys) servers.allocSlotFor(k);
  assert.equal(servers.slots.size, 1, 'one slot for the whole feature');
  assert.equal(servers.slots.get('custom-reports'), 0);

  // a second, unrelated feature gets its own slot
  servers.allocSlotFor(servers.featureFor(`${BASE}/ab-be/accept-blue/.worktrees/merchant-mfa`));
  assert.equal(servers.slots.get('merchant-mfa'), 1);

  // reconcileSlots agrees with the same key function
  servers.reconcileSlots(new Map([[feature[0].path, { pid: 1, ports: [1233] }]]));
  assert.deepEqual([...servers.slots.keys()], ['custom-reports'], 'the feature with no running server was released');
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('launch ports for a slotted repo are unchanged at slot 0', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-noreg2-'));
  const cfg = {
    ...OWNER_CONFIG,
    _stateDir: stateDir,
    concurrency: {
      enabled: true, offsetStep: 100, maxSlots: 3,
      repos: { 'accept-blue': { portEnv: { api__port_su: 1231, api__port_iso: 1232, api__port: 1233, api__port_merchant: 1239, api__port_internal: 1999 }, slotEnv: ['redis__db'] } },
    },
  };
  const servers = new Servers(cfg, createIdentity(cfg));
  servers.allocSlotFor('custom-reports'); // slot 0
  const { env, ports } = servers.launchOpts('accept-blue', 'custom-reports');
  assert.deepEqual(ports, [1231, 1232, 1233, 1239, 1999], 'slot 0 is the configured ports, untouched');
  assert.equal(env.redis__db, '0');
  fs.rmSync(stateDir, { recursive: true, force: true });
});
