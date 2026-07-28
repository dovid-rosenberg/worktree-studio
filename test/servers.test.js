'use strict';
// server/servers.js's own resources: the descriptor it hands a launched dev
// server, and the log file it keeps appending to for the worktree's life.
//
// Both are things the daemon holds for as long as it runs, so they are asserted
// against the process's real descriptor table rather than against a mock.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Servers } = require('../server/servers');

function servers(extra = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-servers-'));
  const cfg = { _stateDir: stateDir, web: { port: 0 }, start: { api: { cmd: ':', ports: [] } }, ...extra };
  return new Servers(cfg);
}

function tempWorktree() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wts-wt-')); }

// Descriptors open in THIS process. /dev/fd is the calling process's own
// descriptor table on macOS and Linux alike, so this counts exactly what a
// long-lived daemon would be accumulating.
function openFds() { return fs.readdirSync('/dev/fd').length; }

test('start() does not leak the log descriptor it hands the child', async () => {
  const s = servers();
  const wt = tempWorktree();
  await s.start('api', wt); // warm-up: creates the log, the lock dir, the state file
  const before = openFds();
  for (let i = 0; i < 6; i++) await s.start('api', wt); // eslint-disable-line no-await-in-loop
  const after = openFds();
  assert.ok(after - before <= 1, `6 launches leaked ${after - before} descriptor(s)`);
  fs.rmSync(wt, { recursive: true, force: true });
});
