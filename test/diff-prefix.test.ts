/*
 * The bytes we parse must not depend on the READER's ~/.gitconfig.
 *
 * `hunks.ts` passed a set of canonicalizing flags with a comment explaining exactly why;
 * `review.ts` ran the bare command. Both feed the same parser, and `stripPrefix()` chops a
 * leading `a/` — so for a user with `diff.noprefix = true`, git emits
 * `--- server/review.ts` rather than `--- a/server/review.ts`, the parser chops the real
 * first directory, and every file in a subdirectory is mislabelled in the Changes pane.
 *
 * Driven with the config actually set, because the whole defect is about a setting the
 * test machine does not normally have.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { working, workingFileDiff } from '../server/review.ts';
import { parsePatch } from '../server/diff.ts';

/** A repo whose local config is the hostile one. */
function repoWith(settings: string[][]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-prefix-'));
  const g = (...a: string[]) =>
    execFileSync('git', ['-C', dir, ...a], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
  g('init', '-b', 'main');
  for (const [k, v] of settings) g('config', k, v);
  fs.mkdirSync(path.join(dir, 'server'));
  fs.writeFileSync(path.join(dir, 'server', 'review.ts'), 'one\n');
  g('add', '-A');
  g('commit', '-m', 'init');
  fs.writeFileSync(path.join(dir, 'server', 'review.ts'), 'one changed\n');
  return dir;
}

/*
 * The PARSED patch is where this shows, not the file list — `working()` builds its list
 * from `--numstat -z`, which carries no prefixes at all. It is the per-file diff that
 * feeds parsePatch, and parsePatch strips a leading `a/`.
 */
const CASES: Array<[string, string[][]]> = [
  ['diff.noprefix', [['diff.noprefix', 'true']]],
  ['diff.mnemonicPrefix', [['diff.mnemonicPrefix', 'true']]],
  ['no unusual config', []],
];

for (const [label, settings] of CASES) {
  test(`a subdirectory path survives parsing under ${label}`, async () => {
    const dir = repoWith(settings);
    const patch = await workingFileDiff(dir, 'server/review.ts');
    const parsed = parsePatch(patch);
    assert.equal(
      parsed[0]?.path,
      'server/review.ts',
      `under ${label} the leading directory was chopped — every file in a subdirectory is mislabelled`,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('the file LIST is unaffected either way — it comes from --numstat, not the patch', async () => {
  const dir = repoWith([['diff.noprefix', 'true']]);
  const out = await working(dir);
  assert.deepEqual(
    out.files.map((f) => f.file),
    ['server/review.ts'],
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
