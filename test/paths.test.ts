/*
 * server/paths.ts: the one place that knows where Studio's files are.
 *
 * Two kinds of assertion here, and the second kind is the point of the file.
 *
 * The resolution RULES — which env var wins, what a missing config.json means — are
 * pinned because bin/wt-studio.ts and (in time) the shell integrations resolve their
 * endpoint through them, and a CLI that looks in the wrong place fails as "the server
 * isn't running", which sends you to read a log of a daemon that is running fine.
 *
 * The AGREEMENT tests are the ones that earn their keep. paths.ts deliberately duplicates
 * server/config.ts and server/security.ts rather than importing them (a CLI that wants a
 * port number must not drag in the config loader and its first-run seeding), and a
 * duplicated constant with nothing comparing it is a constant that drifts. These compare
 * it. Move `web.port` in config.ts and this file fails, naming both sides.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../server/paths.ts';
import * as configMod from '../server/config.ts';
import { loadToken } from '../server/security.ts';

/** A home directory nothing else in the suite writes to. */
const HOME = '/tmp/wts-paths-home';

const tmp = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// ---------------------------------------------------------------------------
// resolution rules
// ---------------------------------------------------------------------------

test('with a bare environment everything hangs off the home directory', () => {
  const env = { HOME };
  assert.equal(paths.configDir(env), path.join(HOME, '.config', 'worktree-studio'));
  assert.equal(paths.configFile(env), path.join(HOME, '.config', 'worktree-studio', 'config.json'));
  assert.equal(paths.stateDir(env), path.join(HOME, '.local', 'state', 'worktree-studio'));
  // Config and state are deliberately NOT the same tree: the token is 0600 state, not
  // configuration, and a user syncing their dotfiles must not carry it to another machine.
  assert.notEqual(path.dirname(paths.configDir(env)), path.dirname(paths.stateDir(env)));
});

test('the token file is `token` inside the state dir, and moves with it', () => {
  const env = { HOME, WT_STUDIO_STATE: '/var/somewhere' };
  assert.equal(paths.tokenFile(env), path.join('/var/somewhere', 'token'));
  assert.equal(paths.stateDir(env), '/var/somewhere');
});

test('$WT_STUDIO_CONFIG_DIR moves the config file with it', () => {
  const env = { HOME, WT_STUDIO_CONFIG_DIR: '/etc/wts' };
  assert.equal(paths.configDir(env), '/etc/wts');
  assert.equal(paths.configFile(env), path.join('/etc/wts', 'config.json'));
});

test('$WT_STUDIO_CONFIG names the FILE and wins outright', () => {
  // It is not required to sit inside $WT_STUDIO_CONFIG_DIR — pointing one somewhere else
  // must not oblige you to keep the other in step, which is what a `join` would demand.
  const env = { HOME, WT_STUDIO_CONFIG_DIR: '/etc/wts', WT_STUDIO_CONFIG: '/tmp/other.json' };
  assert.equal(paths.configFile(env), '/tmp/other.json');
  assert.equal(paths.configDir(env), '/etc/wts', 'the directory is still its own answer');
});

// ---------------------------------------------------------------------------
// reading what is there — total, on purpose
// ---------------------------------------------------------------------------

test('the port comes from config.json, and every way of not having one is the default', () => {
  const dir = tmp('wts-paths-port-');
  const at = (contents?: string): number => {
    const file = path.join(dir, 'config.json');
    if (contents === undefined) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, contents);
    return paths.readPort({ WT_STUDIO_CONFIG: file });
  };

  assert.equal(at('{"web":{"port":9123}}'), 9123);
  assert.equal(at(undefined), paths.DEFAULT_PORT, 'no file at all — a first run');
  assert.equal(at('{ not json'), paths.DEFAULT_PORT, 'a hand-edit in progress');
  assert.equal(at('{}'), paths.DEFAULT_PORT, 'a file with no web block');
  // 0 is what "you pick a port" looks like, and config.ts resolves the port with `||`,
  // so it becomes the default there too. Answering 0 here would send a client to
  // http://127.0.0.1:0.
  assert.equal(at('{"web":{"port":0}}'), paths.DEFAULT_PORT);
  assert.equal(at('{"web":{"port":"8080"}}'), 8080, 'a hand-edited string is still a port');
  assert.equal(at('{"web":{"port":"nope"}}'), paths.DEFAULT_PORT);

  assert.equal(paths.baseUrl({ WT_STUDIO_CONFIG: path.join(dir, 'config.json') }), 'http://127.0.0.1:7788');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing token reads as empty rather than throwing — that is "no daemon"', () => {
  const dir = tmp('wts-paths-token-');
  const env = { WT_STUDIO_STATE: dir };
  assert.equal(paths.readToken(env), '', 'nothing has booted here yet');
  // Written with a trailing newline by security.ts, and a token with a newline in it is
  // an invalid header value — so the trim is part of the contract, not tidiness.
  fs.writeFileSync(paths.tokenFile(env), 'deadbeef\n');
  assert.equal(paths.readToken(env), 'deadbeef');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// the duplication, compared
// ---------------------------------------------------------------------------

test('paths.ts resolves the same locations config.ts does', () => {
  // config.ts fixes these at import against the ambient environment, so they are compared
  // against paths.ts's defaults — the same environment, resolved the other way.
  assert.equal(paths.configDir(), configMod.CONFIG_DIR);
  assert.equal(paths.configFile(), configMod.CONFIG_FILE);
  assert.equal(paths.stateDir(), configMod.STATE_DIR);
});

test('paths.DEFAULT_PORT is the port config.ts ships', () => {
  assert.equal(
    paths.DEFAULT_PORT,
    configMod.defaults().web.port,
    'server/paths.ts duplicates this constant on purpose; the two must not drift',
  );
});

test('paths.readToken reads the file security.ts writes', () => {
  const dir = tmp('wts-paths-agree-');
  const written = loadToken(dir);
  assert.match(written, /^[0-9a-f]{64}$/, 'security.ts minted a token');
  assert.equal(
    paths.readToken({ WT_STUDIO_STATE: dir }),
    written,
    'paths.tokenFile() must name the file security.ts wrote, or every CLI call is unauthenticated',
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
