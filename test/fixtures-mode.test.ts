import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, fixturesFlag, loadFixtures, refuseMutations } from '../server/fixtures.ts';

const tmp = (body: string) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wts-fx-')), 'fleet.json');
  fs.writeFileSync(f, body);
  return f;
};
const VALID = JSON.stringify({ repos: [], features: [], sessions: [], mux: 'tmux' });

test('--fixtures is read in both spellings', () => {
  assert.equal(fixturesFlag(['node', 'server.ts', '--fixtures', 'a.json']), 'a.json');
  assert.equal(fixturesFlag(['--fixtures=b.json']), 'b.json');
  assert.equal(fixturesFlag(['--other', 'x']), null, 'absent means null, not empty string');
  assert.equal(
    fixturesFlag(['--fixtures']),
    '',
    'present with no value is empty, and loadFixtures rejects it',
  );
});

/*
 * Every rejection below matters for the same reason: a fixtures daemon that quietly falls
 * back to a real scan would show a banner saying nothing is real while acting on a fleet
 * that is. Refusing to boot is the only safe failure.
 */
test('a missing file is refused, not ignored', () => {
  assert.throws(() => loadFixtures('/nope/fleet.json'), /cannot read/);
});

test('an empty flag is refused', () => {
  assert.throws(() => loadFixtures(''), /needs a file path/);
});

test('invalid JSON is refused, and says so', () => {
  assert.throws(() => loadFixtures(tmp('{oops')), /not valid JSON/);
});

test('a payload without repos/features is refused', () => {
  assert.throws(() => loadFixtures(tmp('{"mux":"tmux"}')), /no repos\/features/);
});

test('an array is refused — a state payload is an object', () => {
  assert.throws(() => loadFixtures(tmp('[]')), /must be a state payload object/);
});

test('a real-shaped payload loads', () => {
  const p = loadFixtures(tmp(VALID));
  assert.deepEqual(p.repos, []);
  assert.equal(p.mux, 'tmux');
});

test('describe() names the file and counts, for the boot log', () => {
  const f = tmp(JSON.stringify({ repos: [], features: [{ name: 'a' }], sessions: [{ id: 's' }] }));
  const line = describe(f, loadFixtures(f));
  assert.match(line, /FIXTURES:/);
  assert.match(line, /1 feature\(s\)/);
  assert.match(line, /1 session\(s\)/);
});

/*
 * The banner claims nothing is executed. These make that claim true — a captured fixture
 * fleet is indistinguishable from the fleet it came from, so "start this stack" reaching
 * a real worktree is exactly the failure this mode would otherwise introduce.
 */
test('reads are allowed through untouched', () => {
  let nexted = false;
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    nexted = false;
    refuseMutations()({ method }, { status: () => ({ json: () => {} }) }, () => (nexted = true));
    assert.equal(nexted, true, `${method} must pass`);
  }
});

test('writes are refused with a reason, and never reach the handler', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    let code = 0;
    let body: { error?: string } = {};
    let nexted = false;
    refuseMutations()(
      { method },
      {
        status: (c: number) => ({
          json: (b: { error?: string }) => {
            code = c;
            body = b;
          },
        }),
      },
      () => (nexted = true),
    );
    assert.equal(nexted, false, `${method} must not reach the handler`);
    assert.equal(code, 409);
    assert.match(String(body.error), /fixtures mode/);
  }
});
