// server/session-store.ts: reading and writing sessions.json across shape changes.
//
// The file has been an unversioned bare array since the first commit, and the shape
// inside it has already drifted — ids that were a clock reading and are now UUIDs,
// `muxName` persisted so existing sessions keep the name they were created with, a
// PENDING_TAB sentinel in `tabs`. Every one of those was absorbed by writing code that
// tolerates both shapes forever, because there was nowhere to put a migration. This is
// the somewhere.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadSessions, saveSessions, STATE_VERSION } from '../server/session-store.ts';
import type { Session } from '../server/types.ts';

function tempFile(contents?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-store-'));
  const file = path.join(dir, 'sessions.json');
  if (contents !== undefined) fs.writeFileSync(file, contents);
  return file;
}

const aSession = (id: string) => ({ id, title: id, muxName: `wts-${id}` }) as unknown as Session;

test('a missing file loads as no sessions, not as a crash', () => {
  const { sessions, version } = loadSessions(tempFile());
  assert.deepEqual(sessions, []);
  assert.equal(version, STATE_VERSION, 'a fresh install is already current');
});

/*
 * The shape every existing install has on disk right now. It has no version field
 * because it predates the idea of one, which is exactly why "no envelope" has to mean
 * version 0 rather than "unreadable".
 */
test('a bare array is read as the unversioned original', () => {
  const file = tempFile(JSON.stringify([{ id: 's_1', title: 'old' }]));
  const { sessions, version } = loadSessions(file);
  assert.equal(version, 0, 'recognised as pre-envelope');
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.id, 's_1', 'and the sessions themselves came through');
});

test('an envelope is read at its stated version', () => {
  const file = tempFile(JSON.stringify({ version: STATE_VERSION, sessions: [{ id: 's_2' }] }));
  const { sessions, version } = loadSessions(file);
  assert.equal(version, STATE_VERSION);
  assert.equal(sessions[0]?.id, 's_2');
});

test('a save writes the envelope, and a load reads back exactly what went in', () => {
  const file = tempFile();
  saveSessions(file, [aSession('s_3'), aSession('s_4')]);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.version, STATE_VERSION, 'the version is on disk, not inferred');
  assert.equal(raw.sessions.length, 2);
  assert.deepEqual(
    loadSessions(file).sessions.map((s) => s.id),
    ['s_3', 's_4'],
  );
});

// The upgrade path an existing install takes on its first boot after this lands.
test('an unversioned file is migrated forward on load and re-saved as an envelope', () => {
  const file = tempFile(JSON.stringify([{ id: 's_old', title: 'from before' }]));
  const { sessions } = loadSessions(file);
  saveSessions(file, sessions);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.version, STATE_VERSION);
  assert.equal(raw.sessions[0].id, 's_old', 'nothing was dropped on the way through');
});

/*
 * The upgrade is ONE-WAY, and that is the whole reason for this test.
 *
 * A Studio predating this module reads sessions.json as `for (const s of parsed)`. An
 * envelope is not merely unrecognised by that — it is not iterable, so the
 * SessionManager constructor throws and the daemon does not boot. Rolling back would
 * otherwise mean hand-reconstructing the file that holds every claudeSessionId.
 */
test('the pre-envelope file is kept, so a rollback to an older Studio is one cp', () => {
  const file = tempFile(JSON.stringify([{ id: 's_old', title: 'from before' }]));
  loadSessions(file);
  saveSessions(file, [{ id: 's_old' } as unknown as Session]);

  const kept = `${file}.v0-pre-envelope`;
  assert.ok(fs.existsSync(kept), 'the original shape survived the upgrade');
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(kept, 'utf8'))), 'and it is still a bare array');
});

test('the pre-envelope copy is written once, not re-made on every boot', () => {
  const file = tempFile(JSON.stringify([{ id: 's_old' }]));
  loadSessions(file);
  const kept = `${file}.v0-pre-envelope`;
  fs.writeFileSync(kept, '["sentinel"]'); // stand in for "the copy from the real upgrade"
  loadSessions(file);
  assert.equal(fs.readFileSync(kept, 'utf8'), '["sentinel"]', 'the first copy is the one that matters');
});

/*
 * A file written by a NEWER Studio than the one reading it — the shape a downgrade
 * produces. Guessing at fields we do not know about is how state gets destroyed, and
 * this file is the only record that a session exists at all. So: keep a copy before
 * anything can overwrite it, and carry on with what we can read.
 */
test('a file from a newer version is preserved before it can be overwritten', () => {
  const file = tempFile(JSON.stringify({ version: STATE_VERSION + 5, sessions: [{ id: 's_future' }] }));
  const { sessions, version } = loadSessions(file);
  assert.equal(version, STATE_VERSION + 5);
  assert.equal(sessions[0]?.id, 's_future', 'still loaded — it is probably fine, just newer');
  const kept = fs
    .readdirSync(path.dirname(file))
    .filter((f) => f.startsWith('sessions.json.v') || f.includes('newer'));
  assert.equal(kept.length, 1, 'a copy of the newer file survives the downgrade');
});

// Garbage is not a version-0 file. It is the case readJsonState already handles by
// setting the original aside, and this must not turn it into "no sessions, carry on".
test('a corrupt file yields no sessions and is set aside, not parsed as empty', () => {
  const file = tempFile('{ this is not json');
  const { sessions } = loadSessions(file);
  assert.deepEqual(sessions, []);
  const aside = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('corrupt'));
  assert.equal(aside.length, 1, 'the unreadable original was kept');
});

// An envelope whose `sessions` key is missing or the wrong type is not a reason to throw
// on boot — it is a reason to start empty and keep the file.
test('an envelope with no usable sessions array loads as empty', () => {
  assert.deepEqual(loadSessions(tempFile(JSON.stringify({ version: 1 }))).sessions, []);
  assert.deepEqual(loadSessions(tempFile(JSON.stringify({ version: 1, sessions: 'nope' }))).sessions, []);
});
