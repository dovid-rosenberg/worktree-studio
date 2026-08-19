/*
 * The two shared helpers that were each a pair of copies until they were not.
 *
 * The route GUARDS from the same module are exercised through express in
 * test/api-routing.test.ts, where the thing worth pinning is what a client receives.
 * These two are pure, and what is worth pinning is the rule itself — because in both
 * cases the two copies had already drifted in spelling, which is the state one behaviour
 * change away from drifting in behaviour.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { defaultBranchOf, editorCommands } from '../server/util.ts';

// ---------------------------------------------------------------------------
// editorCommands: POST /open and POST /group/open built this expression twice
// ---------------------------------------------------------------------------

const ZED = { open: 'zed {path}', openGroup: 'zed {paths}' };
const WEBSTORM = { open: 'open -na WebStorm --args {path}' };

test('one path is one command, whatever the editor can do', () => {
  assert.deepEqual(editorCommands(ZED, ['/code/api']), ["zed '/code/api'"]);
  assert.deepEqual(editorCommands(WEBSTORM, ['/code/api']), ["open -na WebStorm --args '/code/api'"]);
});

test('several paths: one workspace for an editor with openGroup, one window each for one without', () => {
  // This is the whole reason the templating is not a lambda at the call site: `openGroup`
  // in one command versus a loop over `open` is one Zed workspace versus four WebStorm
  // windows, and getting it wrong is a mess on the user's screen rather than a log line.
  assert.deepEqual(editorCommands(ZED, ['/code/api', '/code/fe']), ["zed '/code/api' '/code/fe'"]);
  assert.deepEqual(editorCommands(WEBSTORM, ['/code/api', '/code/fe']), [
    "open -na WebStorm --args '/code/api'",
    "open -na WebStorm --args '/code/fe'",
  ]);
});

test('a path containing a replacement token is substituted LITERALLY', () => {
  /*
   * The hazard both copies carried a comment about. `String.replace` expands `$&`,
   * `` $` ``, `$'` and `$$` in the REPLACEMENT string — which here is the shell-quoted
   * path — so a worktree called `$&` would have opened whatever the pattern matched
   * instead, quoting notwithstanding. split/join does no such expansion.
   */
  for (const token of ['$&', '$`', '$$']) {
    const p = `/code/api/.worktrees/${token}`;
    assert.deepEqual(editorCommands(ZED, [p]), [`zed '${p}'`], `${token} was expanded`);
    assert.deepEqual(editorCommands(ZED, [p, '/code/fe']), [`zed '${p}' '/code/fe'`], `${token}, grouped`);
  }
  // `$'` is the fourth of them and also contains a quote, so what shq() hands the
  // template already carries the POSIX `'\''` escape. It must arrive intact.
  assert.deepEqual(editorCommands(ZED, ["/code/api/.worktrees/$'"]), [`zed '/code/api/.worktrees/$'\\'''`]);
});

test('a path with a quote in it stays one shell word', () => {
  // The quoting is shq()'s, and this is the assertion that it is still applied to every
  // path on both branches rather than only the looped one.
  assert.deepEqual(editorCommands(ZED, ["/code/o'brien"]), [`zed '/code/o'\\''brien'`]);
});

test('no paths is no commands — nothing to open is not an error to raise here', () => {
  assert.deepEqual(editorCommands(ZED, []), []);
});

// ---------------------------------------------------------------------------
// defaultBranchOf: routes-commits.ts and routes-review.ts each had a closure
// ---------------------------------------------------------------------------

const SCAN = [
  { name: 'api', defaultBranch: 'develop' },
  { name: 'fe', defaultBranch: 'main' },
  { name: 'docs', defaultBranch: null },
];

test('a scanned repo answers with the branch the scan found', () => {
  assert.equal(defaultBranchOf(SCAN, 'api'), 'develop');
  assert.equal(defaultBranchOf(SCAN, 'fe'), 'main');
});

test("a repo the scan cache has not seen falls back to 'main' rather than nothing", () => {
  // The base of a review diff. An empty string here would produce `git log ..HEAD`, i.e.
  // every commit in the repo reported as this branch's work — which is why the fallback
  // exists at all, and why both panes have to make the same choice.
  assert.equal(defaultBranchOf(SCAN, 'ghost'), 'main', 'outside every baseDir, or a rescan in flight');
  assert.equal(defaultBranchOf(SCAN, 'docs'), 'main', 'scanned, but git had no answer');
  assert.equal(defaultBranchOf([], 'api'), 'main', 'nothing scanned yet');
});
