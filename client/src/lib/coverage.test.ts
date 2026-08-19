import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/*
 * Every test file is actually run by some project.
 *
 * vitest.config.ts splits the suite into `logic` (node) and `components` (jsdom) by
 * include-glob, and its own comment warns that "a test file that no project includes is
 * a test file that silently never runs". That warning was already true when it was
 * written and stayed true: a new directory under src/lib matched neither pattern, so its
 * tests passed by never existing.
 *
 * A green suite that quietly skips a file is worse than a red one, so this fails instead.
 */
const ROOT = path.resolve(import.meta.dirname, '..');

/** Mirrors the include globs in vitest.config.ts, as prefixes relative to src/. */
const COVERED = ['lib/stores/', 'lib/actions/', 'lib/fixtures/', 'lib/components/'];
/** `src/lib/*.test.ts` — the components project's second pattern, one level only. */
const coveredFlat = (rel: string) => path.dirname(rel) === 'lib';

function testFiles(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) testFiles(full, acc);
    else if (e.name.endsWith('.test.ts')) acc.push(path.relative(ROOT, full));
  }
  return acc;
}

describe('vitest project coverage', () => {
  it('runs every *.test.ts under src/', () => {
    const orphans = testFiles(ROOT).filter(
      (rel) => !coveredFlat(rel) && !COVERED.some((p) => rel.startsWith(p)),
    );
    expect(orphans, `not matched by any vitest project include: ${orphans.join(', ')}`).toEqual([]);
  });
});
