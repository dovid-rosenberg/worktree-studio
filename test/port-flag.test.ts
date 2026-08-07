/*
 * `portFlag` — the half of concurrency that was missing.
 *
 * `portEnv` only moves a server that READS the variable, and most frontend dev servers
 * do not: vite, next and ng take `--port` and otherwise bind what their own config says.
 * So running two features at once shifted the backend and left both frontends fighting
 * over one port — the marquee capability working for half a stack, with the failure
 * showing up as "the FE didn't come up" rather than as anything about concurrency.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { Servers } from '../server/servers.ts';
import fs from 'fs';
import os from 'os';
import path from 'path';

function servers(repos: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-pf-'));
  const s = new Servers({
    _stateDir: dir,
    start: { fe: { cmd: 'npm start', ports: [] } },
    concurrency: { enabled: true, offsetStep: 100, maxSlots: 3, repos },
  } as never);
  return { s, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('the flag carries the slot-shifted port, not the base one', () => {
  const { s, cleanup } = servers({
    fe: { portEnv: { WTS_FE_PORT: 3030 }, portFlag: '-- --port {port}' },
  });
  s.slots.set('feat-b', 1);
  assert.equal(s.launchOpts('fe', 'feat-b').portArgs, '-- --port 3130');
  // Slot 0 is the unshifted base — the flag is still passed, so both features are
  // explicit about their port rather than one relying on a default.
  s.slots.set('feat-a', 0);
  assert.equal(s.launchOpts('fe', 'feat-a').portArgs, '-- --port 3030');
  cleanup();
});

test('a repo with no portFlag has its command left exactly alone', () => {
  const { s, cleanup } = servers({ fe: { portEnv: { WTS_FE_PORT: 3030 } } });
  s.slots.set('f', 1);
  assert.equal(s.launchOpts('fe', 'f').portArgs, '');
  cleanup();
});

test('a portFlag with no port to put in it produces nothing', () => {
  // slotEnv-only repos derive no ports; substituting would emit `--port undefined`.
  const { s, cleanup } = servers({ fe: { slotEnv: ['redis__db'], portFlag: '--port {port}' } });
  s.slots.set('f', 2);
  const out = s.launchOpts('fe', 'f');
  assert.equal(out.portArgs, '');
  assert.equal(out.env.redis__db, '2', 'the slot env still works');
  cleanup();
});

test('{port} is replaced everywhere it appears, literally', () => {
  // split/join, not replace(): `$&` and friends in the REPLACEMENT expand otherwise.
  const { s, cleanup } = servers({
    fe: { portEnv: { P: 4000 }, portFlag: '--port {port} --hmr-port {port}' },
  });
  s.slots.set('f', 1);
  assert.equal(s.launchOpts('fe', 'f').portArgs, '--port 4100 --hmr-port 4100');
  cleanup();
});
