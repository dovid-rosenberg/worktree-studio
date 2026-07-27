'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// config.js captures CONFIG_FILE/STATE_DIR from env at require time, so point them
// at a throwaway temp dir BEFORE requiring the module.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-studio-cfg-'));
process.env.WT_STUDIO_CONFIG_DIR = TMP;
process.env.WT_STUDIO_CONFIG = path.join(TMP, 'config.json');
process.env.WT_STUDIO_STATE = path.join(TMP, 'state');

const { load } = require('../server/config');

function writeConfig(obj) {
  fs.writeFileSync(process.env.WT_STUDIO_CONFIG, JSON.stringify(obj, null, 2));
}

// The shipped default patterns that must always be present after load().
const SHIPPED = ['src/config.js', 'src/config/config.js'];

test('load() unions shipped default copyPatterns into an existing (stale) copyPatterns.default', () => {
  // Old on-disk config: has copyPatterns but WITHOUT the newer FE paths.
  writeConfig({ copyPatterns: { default: ['.env', 'config/*-config.js', 'my-custom.txt'] } });
  const cfg = load();
  // user's own patterns survive
  assert.ok(cfg.copyPatterns.default.includes('my-custom.txt'));
  assert.ok(cfg.copyPatterns.default.includes('.env'));
  // shipped defaults are now present
  for (const p of SHIPPED) assert.ok(cfg.copyPatterns.default.includes(p), `missing shipped pattern ${p}`);
  // no duplicates
  assert.equal(cfg.copyPatterns.default.length, new Set(cfg.copyPatterns.default).size);
});

test('load() supplies the full default copyPatterns when config has no copyPatterns key', () => {
  writeConfig({ baseDirs: ['~/x'] });
  const cfg = load();
  for (const p of SHIPPED) assert.ok(cfg.copyPatterns.default.includes(p), `missing shipped pattern ${p}`);
  assert.ok(cfg.copyPatterns.default.includes('.env'));
});

test('load() leaves per-repo copyPatterns overrides untouched', () => {
  writeConfig({ copyPatterns: { default: ['.env'], 'merchant-v3': ['special/only-here.js'] } });
  const cfg = load();
  assert.deepEqual(cfg.copyPatterns['merchant-v3'], ['special/only-here.js']);
  for (const p of SHIPPED) assert.ok(cfg.copyPatterns.default.includes(p), `missing shipped pattern ${p}`);
});
