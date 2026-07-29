// Loads (and seeds on first run) ~/.config/worktree-studio/config.json.
// Reuses worktree-dash's config for baseDirs/start/editors when present so the
// two feel like one world.
import fs from 'fs';
import path from 'path';
import { HOME, expandTilde, readJson, writeJson } from './util.ts';
import * as security from './security.ts';
import { DEFAULT_COPY_ALWAYS } from './worktree.ts';
import type { ConcurrencyConfig, Config, PartialDeep } from './types.ts';

const CONFIG_DIR = process.env.WT_STUDIO_CONFIG_DIR || path.join(HOME, '.config', 'worktree-studio');
const CONFIG_FILE = process.env.WT_STUDIO_CONFIG || path.join(CONFIG_DIR, 'config.json');
const STATE_DIR = process.env.WT_STUDIO_STATE || path.join(HOME, '.local', 'state', 'worktree-studio');

const DASH_CONFIG = path.join(HOME, '.config', 'worktree-dash', 'config.json');

/**
 * What defaults() ships: config.json's own keys, and none of the `_`-prefixed
 * runtime keys load() stamps on afterwards — those exist only in memory, which is
 * why they are required on Config but cannot be part of what a fresh file contains.
 */
export type ShippedConfig = Omit<Config, '_file' | '_stateDir' | '_token'>;

/**
 * config.json as it sits on disk: readConfigFile() has proved it parsed to a JSON
 * object, and nothing more. It *claims* to be a config, so the keys are named — but
 * every one of them is optional, because the file is hand-edited and may predate any
 * of them. The index signature is what the dynamic default-merge in load() writes
 * through, and it is also what keeps keys this version has never heard of.
 */
type OnDiskConfig = PartialDeep<Config> & Record<string, unknown>;

/** The keys of worktree-dash's config.json that Studio reuses. Another tool's file, so all optional. */
interface DashConfig {
  baseDirs?: string[];
  scanDepth?: number;
  editors?: Config['editors'];
  defaultEditor?: string;
  start?: Config['start'];
  webRepos?: string[];
  groups?: Config['groups'];
  runConfigs?: Config['runConfigs'];
}

function defaults(): ShippedConfig {
  // The `|| {}` is load-bearing, hence the nullable type argument: a bare `null` in
  // the file parses fine, so readJson hands one straight back with its fallback
  // untouched.
  const dash: DashConfig = readJson<DashConfig | null>(DASH_CONFIG, {}) || {};
  return {
    baseDirs: dash.baseDirs || ['~/Desktop/ab-code'],
    scanDepth: dash.scanDepth || 3,
    web: { port: 7788, host: '127.0.0.1' },
    claude: { cmd: 'claude' },
    editors: dash.editors || {
      WebStorm: { open: 'open -na WebStorm --args {path}' },
      Zed: { open: '/Applications/Zed.app/Contents/MacOS/cli {path}' },
    },
    defaultEditor: dash.defaultEditor || 'WebStorm',
    // Where a repo's worktrees live. `nested` is the historical convention.
    //   nested   <repo>/<dir>/<name>            dir defaults to `.worktrees`
    //   sibling  <repo>/../<name>
    //   external <root>/<repo>/<name>           root is required
    worktrees: { layout: 'nested', dir: '.worktrees', root: '' },
    // What makes two worktrees in different repos "the same feature" (server/identity.ts).
    //   basename  same directory name (the historical convention)
    //   branch    same capture group of `branchPattern` applied to the branch name
    //   manifest  listed together in `groups` below
    featureIdentity: { strategy: 'basename', branchPattern: '', branchFlags: '' },
    // Native `wt` copy-patterns (files git ignores get carried into new worktrees).
    // `.env*` covers the individual `.env`/`.env.local` entries kept below for the
    // benefit of configs that list them explicitly; `.vscode/*.json` is the
    // editor-agnostic counterpart of the JetBrains run configs in copyAlways.
    copyPatterns: {
      default: [
        '.env', '.env.local', '.env.*.local', '.env*',
        'config/*-config.ts', 'src/config.ts', 'src/config/config.ts',
        '.vscode/*.json',
      ],
    },
    // Patterns copied into a new worktree whether or not git ignores them — editor
    // scratch a checkout will not bring along. Empty the array to turn it off.
    copyAlways: { default: [...DEFAULT_COPY_ALWAYS] },
    // per-repo dev-server launch config { cmd, ports }
    start: dash.start || {},
    // repos that serve a browsable frontend — get an "Open app ↗" button that
    // opens their (lsof-discovered) running port, incl. concurrency-shifted ports.
    webRepos: dash.webRepos || ['merchant-v3', 'ab-iso-fe', 'ab-su'],
    // manual feature groups: [{ name, members: ["repo/branch-or-wtname"] }]
    groups: dash.groups || [],
    // imported editor run/test configs: { "<repo>": [{ name, cmd, kind, source }] }
    runConfigs: dash.runConfigs || {},
    sources: {
      github: { enabled: true },
      gitlab: { enabled: false, host: 'https://gitlab.com', token: '' },
      asana: { enabled: false, token: '', workspace: '' },
    },
    // attention notifications when a session changes state (see stores/notify.svelte.ts)
    notify: { waiting: true, sound: true, idle: false },
    // Run 2–3 features at once: each feature gets a slot (0,1,2…); slot n offsets
    // every dev-server port by n*offsetStep and sets each slotEnv key to n. Slot 0
    // == the repo's configured ports, so a single feature is unchanged.
    // `repos` ships EMPTY — the port map is one organisation's, not a default. See
    // docs/config.md for a fully worked multi-repo example to copy.
    concurrency: {
      enabled: true,
      offsetStep: 100,
      maxSlots: 3,
      repos: {},
    },
  };
}

// One-time migration, and the reason `concurrency.repos` can safely ship empty.
//
// Until now this port map lived in defaults(), and defaults() is merged into the
// on-disk config at load time — so an install whose config.json never wrote a
// `concurrency` key was silently *running on it*. Emptying the defaults would
// therefore turn concurrency off under that install's feet: every dev server back
// on slot-0 ports, and "stop & switch" conflicts back for repos that used to run
// side by side. So a config that predates the key gets the old block written into
// it, once, and owns it from then on.
//
// A config created from today's defaults() always HAS a `concurrency` key (with an
// empty `repos`), so a new install never matches this branch and never sees these
// values. Delete this once no pre-0.2 config remains.
const LEGACY_CONCURRENCY = (): ConcurrencyConfig => ({
  enabled: true,
  offsetStep: 100,
  maxSlots: 3,
  repos: {
    'accept-blue': {
      portEnv: { api__port_su: 1231, api__port_iso: 1232, api__port: 1233, api__port_merchant: 1239, api__port_internal: 1999 },
      slotEnv: ['redis__db'],
    },
    // The FE repos hardcode accept-blue's slot-0 ports in a gitignored, per-worktree
    // config file. On stack-start Studio shifts ALL of the sibling's port families in
    // that file to this feature's slot (ab-su references su/merchant/iso, so a single
    // per-port key is wrong — every referenced accept-blue port moves by slot*step).
    'merchant-v3': {
      portEnv: { WTS_FE_PORT: 3030 }, // vite; localhost:1239 (merchant)
      configPatch: { file: 'src/config.ts', siblingRepo: 'accept-blue' },
    },
    'ab-iso-fe': {
      portEnv: { WTS_FE_PORT: 9000 }, // webpack-dev-server; iso 1232 + merchant 1239
      configPatch: { file: 'src/config/config.ts', siblingRepo: 'accept-blue' },
    },
    'ab-su': {
      portEnv: { WTS_FE_PORT: 8000 }, // vite; su 1231 + merchant 1239 + iso 1232
      configPatch: { file: 'src/config/config.ts', siblingRepo: 'accept-blue' },
    },
  },
});

// Mutates `raw` (the config exactly as it sits on disk, before any default merge)
// and returns true when something changed and it should be written back. Writing
// back is what makes the migration one-time: the key is then present forever.
function migrate(raw: OnDiskConfig | null | undefined): boolean {
  if (raw && typeof raw === 'object' && !('concurrency' in raw)) {
    raw.concurrency = LEGACY_CONCURRENCY();
    return true;
  }
  return false;
}

// Non-fatal sanity check of the concurrency block (this is a local dev tool — warn,
// never throw). Flags two footguns:
//   - maxSlots > 16: redis__db is set to the slot index; redis ships 16 DBs (0..15),
//     so slots >= 16 would collide on the redis DB index.
//   - port-family collisions: within slots 0..maxSlots-1, family i at slot a and family j
//     at slot b land on the same port when base_i - base_j == (b-a)*offsetStep. That happens
//     iff |base_i - base_j| is a multiple of offsetStep no larger than (maxSlots-1)*offsetStep.
function validateConcurrency(cfg: PartialDeep<Config> | null | undefined): void {
  const c = cfg && cfg.concurrency;
  if (!c || !c.enabled) return;
  // `|| 0` reads exactly as an absent value did: every use of `step` below sits
  // behind `step > 0`, which `undefined` and `0` both fail.
  const step = c.offsetStep || 0;
  const max = c.maxSlots || 1;
  if (max > 16) {
    console.warn(`[wt-studio] concurrency.maxSlots=${max} exceeds 16 (redis DB index limit); slots >= 16 collide on redis__db.`);
  }
  for (const [repo, rc] of Object.entries(c.repos || {})) {
    const bases = Object.values((rc && rc.portEnv) || {});
    for (let i = 0; i < bases.length; i++) {
      for (let j = i + 1; j < bases.length; j++) {
        // A parsed JSON object has no holes, so neither does Object.values over one:
        // the `| undefined` here is PartialDeep's doing, not the file's. `?? NaN`
        // says so without asserting it away — NaN fails every test below, which is
        // what the arithmetic on an absent value already did.
        const diff = Math.abs((bases[i] ?? NaN) - (bases[j] ?? NaN));
        if (step > 0 && diff % step === 0 && diff / step <= max - 1) {
          console.warn(`[wt-studio] concurrency: repo '${repo}' ports ${bases[i]} and ${bases[j]} collide across slots 0..${max - 1} `
            + `at offsetStep ${step} (diff ${diff} is a multiple of the step within slot range); increase offsetStep or reduce maxSlots.`);
        }
      }
    }
  }
}

// The whole of what parsing config.json proves about it, named so that the narrowing
// and the refusal below are one expression rather than two that can drift.
function isJsonObject(v: unknown): v is OnDiskConfig {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Read config.json, telling "not there" apart from "there but broken".
//
// readJson() collapses both into its fallback, and load() answered a null by
// writing defaults() straight over the file. So a single trailing comma in a
// file the user is explicitly invited to edit — SwiftBar has an "Edit config…"
// item — silently destroyed baseDirs, start commands, editors, groups and the
// whole concurrency.repos port map, printed nothing, and left no way back.
//
// A syntax error is not a state to recover from by guessing; it is one the user
// fixes in ten seconds if they are told. So: refuse, loudly, and do not touch
// the file. Not overwriting it is a stronger guarantee than backing it up —
// what is on disk is still exactly what they wrote.
function readConfigFile(): { absent: true; cfg?: undefined } | { absent?: false; cfg: OnDiskConfig } {
  let text: string;
  try { text = fs.readFileSync(CONFIG_FILE, 'utf8'); }
  catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return { absent: true };
    throw new Error(`[wt-studio] cannot read ${CONFIG_FILE}: ${err.message}`);
  }
  // An empty (or whitespace-only) file is what a bare `touch` leaves behind, and
  // there is nothing in it to lose — seed it like an absent one.
  if (!text.trim()) return { absent: true };
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (e) {
    throw new Error(
      `[wt-studio] ${CONFIG_FILE} is not valid JSON: ${(e as Error).message}\n`
      + '  Your config has NOT been modified — fix the syntax error and start Studio again.\n'
      + '  (Refusing to boot on purpose: seeding defaults over it would lose baseDirs,\n'
      + '   start commands, editors, groups and the concurrency port map.)',
    );
  }
  // `[]`, `"x"` or `null` parse fine but cannot be merged with defaults, and
  // treating them as absent would overwrite the file just the same.
  if (!isJsonObject(parsed)) {
    throw new Error(
      `[wt-studio] ${CONFIG_FILE} must contain a JSON object, found ${Array.isArray(parsed) ? 'an array' : typeof parsed}.\n`
      + '  Your config has NOT been modified.',
    );
  }
  return { cfg: parsed };
}

function load(): Config {
  const found = readConfigFile();
  let cfg = found.absent ? null : found.cfg;
  if (!cfg) {
    cfg = defaults();
    writeJson(CONFIG_FILE, cfg);
  } else {
    // Seed keys that used to be supplied by defaults() BEFORE the merge below, and
    // persist them, so emptying a default can never silently change behavior.
    if (migrate(cfg)) writeJson(CONFIG_FILE, cfg);
    // shallow-merge missing top-level keys from defaults (forward-compat)
    const d = defaults();
    for (const [k, v] of Object.entries(d)) if (!(k in cfg)) cfg[k] = v;
    if (!cfg.web) cfg.web = d.web;
    // `== null`, not `!`: port 0 is a legitimate value meaning "let the OS pick a free
    // one", and a falsy test silently rewrote it to 7788 — so a config asking for an
    // ephemeral port got the default and then refused to boot against whatever was
    // already listening there. Same for host: '' is not a reason to override.
    if (cfg.web.port == null) cfg.web.port = d.web.port;
    if (cfg.web.host == null) cfg.web.host = d.web.host;
    // Targeted deep-merge for the `.default` pattern lists only: the shallow merge
    // above skips them whenever the on-disk config already has a (possibly stale)
    // copyPatterns/copyAlways key, so newly-shipped default patterns would never
    // reach existing users. Union the shipped defaults into the user's default array
    // (de-duped, user's extra patterns kept). Per-repo overrides are left untouched.
    for (const key of ['copyPatterns', 'copyAlways'] as const) {
      cfg[key] = cfg[key] || {};
      cfg[key].default = [...new Set([...(cfg[key].default || []), ...d[key].default])];
    }
    // Same reasoning one level down for the two convention blocks: a config written
    // before `layout`/`strategy` existed must still get their defaults, and a config
    // that sets only one sub-key must keep the rest.
    for (const key of ['worktrees', 'featureIdentity'] as const) {
      cfg[key] = { ...d[key], ...(cfg[key] || {}) };
    }
  }
  cfg._file = CONFIG_FILE;
  cfg._stateDir = STATE_DIR;
  cfg.baseDirs = (cfg.baseDirs || []).map(expandTilde);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // The boot token lives beside the state, not in config.json — config.json is a file
  // the user opens and edits (SwiftBar even has an "Edit config…" item). `_`-prefixed
  // keys are stripped by save(), so it can ride on cfg and reach sessions.ts/status.ts
  // without a second plumbing path.
  cfg._token = security.loadToken(STATE_DIR);
  validateConcurrency(cfg);
  // The one point where this module vouches for the shape, and everything above is
  // what earns it: every top-level key defaults() ships is present, the two
  // convention blocks are filled in sub-key by sub-key, and the runtime keys are
  // stamped. What is NOT earned is the *type* of a value the user hand-wrote —
  // `"web": "nope"` survives this untouched, exactly as it always has, which is why
  // readers downstream take a PartialDeep<Config> and re-check what they read.
  return cfg as Config;
}

// Persist config back to disk (strips internal _-prefixed runtime keys).
function save(cfg: Config): void {
  const out: Record<string, unknown> = {};
  // Entries rather than keys: a config also carries whatever else the user wrote in
  // it, and copying those through unchanged is the point of iterating at all.
  for (const [k, v] of Object.entries(cfg)) if (!k.startsWith('_')) out[k] = v;
  writeJson(cfg._file || CONFIG_FILE, out);
}

export { load, save, defaults, migrate, validateConcurrency, CONFIG_FILE, CONFIG_DIR, STATE_DIR };
