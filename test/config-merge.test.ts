// The safety property behind emptying `concurrency.repos` in defaults():
// loading an EXISTING config must never lose or weaken what that install was
// already running on.
//
// Two cases, and they are not the same:
//   - a config that spells `concurrency` out  → left exactly as written
//   - a config with an empty `repos`           → left empty, never re-seeded
//
// A one-time migrate() used to write the old accept.blue port map into any config that
// predated the `concurrency` key. Its own comment said to delete it once no such config
// remained; that point was reached, so the migration and its five tests are gone. What
// those tests actually protected — that loading an existing config never loses or
// weakens what the install was running on — is still covered below.
//
// Every test here runs against a throwaway temp config. Nothing reads or writes
// ~/.config/worktree-studio/config.json.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-studio-merge-'));
process.env.WT_STUDIO_CONFIG_DIR = TMP;
process.env.WT_STUDIO_CONFIG = path.join(TMP, 'config.json');
process.env.WT_STUDIO_STATE = path.join(TMP, 'state');

// A DYNAMIC import, because a static one is hoisted above the three assignments
// directly above it and config.ts captures these three from the environment once, at
// evaluation time. Under CommonJS the require ran here, in source order; under ESM
// only `await import` still does, and getting this wrong points load() at the real
// ~/.config/worktree-studio/config.json.
const { load, defaults } = await import('../server/config.ts');

const FILE = process.env.WT_STUDIO_CONFIG;
const writeConfig = (obj: unknown) => fs.writeFileSync(FILE, JSON.stringify(obj, null, 2));
const readConfig = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));

// The accept.blue block that used to live in defaults() — the exact shape an
// existing install was running on.
const OLD_CONCURRENCY = {
  enabled: true,
  offsetStep: 100,
  maxSlots: 3,
  repos: {
    'accept-blue': {
      portEnv: {
        api__port_su: 1231,
        api__port_iso: 1232,
        api__port: 1233,
        api__port_merchant: 1239,
        api__port_internal: 1999,
      },
      slotEnv: ['redis__db'],
    },
    'merchant-v3': {
      portEnv: { WTS_FE_PORT: 3030 },
      configPatch: { file: 'src/config.ts', siblingRepo: 'accept-blue' },
    },
    'ab-iso-fe': {
      portEnv: { WTS_FE_PORT: 9000 },
      configPatch: { file: 'src/config/config.ts', siblingRepo: 'accept-blue' },
    },
    'ab-su': {
      portEnv: { WTS_FE_PORT: 8000 },
      configPatch: { file: 'src/config/config.ts', siblingRepo: 'accept-blue' },
    },
  },
};

// ---------------------------------------------- defaults ship company-neutral

test('defaults() ships no concurrency repos at all', () => {
  const d = defaults();
  assert.deepEqual(d.concurrency.repos, {}, 'no organisation-specific ports in the shipped defaults');
  assert.equal(d.concurrency.enabled, true);
  assert.equal(d.concurrency.offsetStep, 100);
  assert.equal(d.concurrency.maxSlots, 3);
});

test('the shipped convention defaults name no company port, repo or file', () => {
  // Only the blocks this module owns outright. `start`/`editors`/`webRepos` are
  // imported from worktree-dash's config at runtime when one exists, so their
  // contents depend on the machine, not on what Studio ships.
  const d = defaults();
  const json = JSON.stringify({
    concurrency: d.concurrency,
    copyPatterns: d.copyPatterns,
    copyAlways: d.copyAlways,
    worktrees: d.worktrees,
    featureIdentity: d.featureIdentity,
  });
  for (const needle of [
    '1231',
    '1232',
    '1233',
    '1239',
    '1999',
    'accept-blue',
    'merchant-v3',
    'ab-iso-fe',
    'ab-su',
    'configPatch',
    'redis__db',
    'WTS_FE_PORT',
  ]) {
    assert.equal(json.includes(needle), false, `the shipped defaults still contain ${needle}`);
  }
});

// ------------------------- an existing config that SPELLS OUT concurrency ----

test('a config that already has the old concurrency values keeps every one of them', () => {
  writeConfig({ baseDirs: ['~/x'], concurrency: OLD_CONCURRENCY });
  const cfg = load();
  assert.deepEqual(cfg.concurrency, OLD_CONCURRENCY, 'empty defaults did not overwrite or prune anything');
  // and the on-disk file is untouched by the load
  assert.deepEqual(readConfig().concurrency, OLD_CONCURRENCY);
});

test('a config with its OWN concurrency repos is not merged with the defaults', () => {
  const mine = {
    enabled: true,
    offsetStep: 50,
    maxSlots: 2,
    repos: { 'my-api': { portEnv: { PORT: 4000 } } },
  };
  writeConfig({ concurrency: mine });
  assert.deepEqual(load().concurrency, mine);
});

test('a config that deliberately disables concurrency stays disabled', () => {
  writeConfig({ concurrency: { enabled: false, offsetStep: 100, maxSlots: 3, repos: {} } });
  assert.equal(load().concurrency.enabled, false);
});

test('a config with an empty concurrency.repos is left empty (not re-seeded)', () => {
  writeConfig({ concurrency: { enabled: true, offsetStep: 100, maxSlots: 3, repos: {} } });
  assert.deepEqual(load().concurrency.repos, {}, 'the key is present, so the migration does not fire');
});

// ---------------------- an existing config that PREDATES the concurrency key --

test('a config created from scratch gets the EMPTY defaults, never the legacy block', () => {
  fs.rmSync(FILE, { force: true });
  const cfg = load();
  assert.deepEqual(cfg.concurrency.repos, {}, 'a new install sees no company ports');
  assert.deepEqual(readConfig().concurrency.repos, {});
  // …and re-loading it does not then trip the migration
  assert.deepEqual(load().concurrency.repos, {});
});

// ---------------------------------------- the other newly-defaulted key sets --

test('a pre-existing config gains the new convention keys at their defaults', () => {
  writeConfig({ baseDirs: ['~/x'] });
  const cfg = load();
  assert.deepEqual(cfg.worktrees, { layout: 'nested', dir: '.worktrees', root: '' });
  assert.deepEqual(cfg.featureIdentity, { strategy: 'basename', branchPattern: '', branchFlags: '' });
});

test('a partially-specified convention block keeps its own values and fills the rest', () => {
  writeConfig({
    worktrees: { layout: 'sibling' },
    featureIdentity: { strategy: 'branch', branchPattern: '^x/(\\d+)' },
  });
  const cfg = load();
  assert.equal(cfg.worktrees.layout, 'sibling');
  assert.equal(cfg.worktrees.dir, '.worktrees', 'the unspecified sub-key is defaulted');
  assert.equal(cfg.featureIdentity.strategy, 'branch');
  assert.equal(cfg.featureIdentity.branchPattern, '^x/(\\d+)');
  assert.equal(cfg.featureIdentity.branchFlags, '');
});

test('copyAlways is unioned into an existing (stale) list, like copyPatterns', () => {
  writeConfig({ copyAlways: { default: ['my-own/*.txt'] } });
  const cfg = load();
  assert.ok(cfg.copyAlways.default.includes('my-own/*.txt'), "the user's own pattern survives");
  assert.ok(cfg.copyAlways.default.includes('.idea/runConfigurations/*.xml'), 'the shipped default arrives');
  assert.equal(cfg.copyAlways.default.length, new Set(cfg.copyAlways.default).size, 'no duplicates');
});

test('the old copyPatterns list still loads and gains the new editor-agnostic patterns', () => {
  writeConfig({ copyPatterns: { default: ['.env', '.env.local', '.env.*.local', 'config/*-config.ts'] } });
  const cfg = load();
  for (const p of ['.env', '.env.local', '.env.*.local', 'config/*-config.ts']) {
    assert.ok(cfg.copyPatterns.default.includes(p), `lost the existing pattern ${p}`);
  }
  for (const p of ['.env*', '.vscode/*.json', 'src/config.ts', 'src/config/config.ts']) {
    assert.ok(cfg.copyPatterns.default.includes(p), `missing the newly shipped ${p}`);
  }
});
