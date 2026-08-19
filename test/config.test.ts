import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

// config.ts captures CONFIG_FILE/STATE_DIR from env when it is evaluated, so point
// them at a throwaway temp dir BEFORE loading the module.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-studio-cfg-'));
process.env.WT_STUDIO_CONFIG_DIR = TMP;
process.env.WT_STUDIO_CONFIG = path.join(TMP, 'config.json');
process.env.WT_STUDIO_STATE = path.join(TMP, 'state');

// Dynamic on purpose: a static import is hoisted above the env assignments above,
// which would aim load() at the real user config instead of TMP.
const { load, validateConcurrency } = await import('../server/config.ts');

/** Run `fn` with console.warn captured, and return what it warned. */
function warnings(fn: () => void): string[] {
  const out: string[] = [];
  const real = console.warn;
  console.warn = (...args: unknown[]) => void out.push(args.join(' '));
  try {
    fn();
  } finally {
    console.warn = real;
  }
  return out;
}

function writeConfig(obj: unknown): void {
  fs.writeFileSync(FILE, JSON.stringify(obj, null, 2));
}

// The shipped default patterns that must always be present after load().
// `.js`, not `.ts`: these globs are matched against the USER'S repo, where the
// extension belongs to that repo. See the note on copyPatterns in server/config.ts.
const SHIPPED = ['src/config.js', 'src/config/config.js'];

test('load() unions shipped default copyPatterns into an existing (stale) copyPatterns.default', () => {
  // Old on-disk config: has copyPatterns but WITHOUT the newer FE paths.
  writeConfig({ copyPatterns: { default: ['.env', 'config/*-config.ts', 'my-custom.txt'] } });
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

// ---------------------------------------------------------------------------
// The scheduler owner has to be a slot that exists
//
// deriveEnv() answers the stand-down value for every slot that is not the owner, so an
// owner outside 0..maxSlots-1 tells every running stack not to run jobs and tells none of
// them to. Jobs then simply never run — the opposite failure to the duplicate-jobs one
// the key exists to prevent, and just as quiet.
// ---------------------------------------------------------------------------

const conc = (scheduler?: { env: string; slot?: number }) => ({
  enabled: true,
  offsetStep: 100,
  maxSlots: 3,
  repos: { api: { portEnv: { api__port: 1233 }, scheduler } },
});

test('a scheduler.slot outside the slot range is warned about by name', () => {
  const w = warnings(() => validateConcurrency({ concurrency: conc({ env: 'job_schedule', slot: 3 }) }));
  assert.equal(w.length, 1);
  assert.match(w[0], /scheduler\.slot=3/);
  assert.match(w[0], /job_schedule/);
  assert.match(w[0], /'api'/);
});

test('an in-range owner (and the default slot 0) warns about nothing', () => {
  assert.deepEqual(
    warnings(() => validateConcurrency({ concurrency: conc({ env: 'job_schedule' }) })),
    [],
  );
  assert.deepEqual(
    warnings(() => validateConcurrency({ concurrency: conc({ env: 'job_schedule', slot: 2 }) })),
    [],
  );
});

test('a repo that declares no scheduler is not warned about — the key is opt-in', () => {
  assert.deepEqual(
    warnings(() => validateConcurrency({ concurrency: conc(undefined) })),
    [],
  );
});

// ---------------------------------------------------------------------------
// A broken config.json must never be overwritten
//
// readJson() collapsed "absent" and "unparseable" into the same null, and load()
// answered a null by writing defaults() over the file. config.json is a file the
// user is invited to edit (SwiftBar ships an "Edit config…" item), so one trailing
// comma destroyed baseDirs, start commands, editors, groups and the concurrency
// port map — silently, and unrecoverably.
// ---------------------------------------------------------------------------

const FILE = process.env.WT_STUDIO_CONFIG;

test('a syntax error in config.json is refused loudly and the file is left alone', () => {
  const original = '{\n  "baseDirs": ["~/code"],\n  "start": { "api": "npm run dev" },\n}\n'; // trailing comma
  fs.writeFileSync(FILE, original);
  assert.throws(() => load(), /is not valid JSON/, 'load() must not answer a broken config with defaults');
  assert.equal(fs.readFileSync(FILE, 'utf8'), original, "the user's config is byte-for-byte untouched");
});

test('the refusal names the file and says the config was not modified', () => {
  fs.writeFileSync(FILE, '{ "baseDirs": [oops] }');
  try {
    load();
    assert.fail('expected a throw');
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    assert.ok(m.includes(FILE), m);
    assert.match(m, /has NOT been modified/);
  }
});

test('a config.json that is valid JSON but not an object is refused, not merged', () => {
  for (const bad of ['[]', '"a string"', 'null', '42']) {
    fs.writeFileSync(FILE, bad);
    assert.throws(() => load(), /not been modified|must contain a JSON object/, `bad top level: ${bad}`);
    assert.equal(fs.readFileSync(FILE, 'utf8'), bad, `${bad} was left on disk`);
  }
});

test('an absent config.json is still seeded with defaults', () => {
  fs.rmSync(FILE, { force: true });
  const cfg = load();
  assert.ok(Array.isArray(cfg.baseDirs));
  assert.ok(fs.existsSync(FILE), 'first run still writes a config');
});

test('an empty config.json is treated as absent — there is nothing in it to lose', () => {
  fs.writeFileSync(FILE, '\n  \n');
  const cfg = load();
  assert.ok(Array.isArray(cfg.baseDirs));
  assert.ok(JSON.parse(fs.readFileSync(FILE, 'utf8')).baseDirs, 'seeded');
});

/*
 * Five slots, not three.
 *
 * The picker makes the ceiling visible in a way the automatic allocator never did — you
 * now SEE that a stuck slot leaves you two — so the number itself wanted raising.
 */
test('defaults ship five slots and the free-ports policy', () => {
  writeConfig({ baseDirs: ['~/x'] });
  const cfg = load();
  assert.equal(cfg.concurrency.maxSlots, 5);
  assert.equal(cfg.concurrency.slotPolicy, 'free-ports');
});
