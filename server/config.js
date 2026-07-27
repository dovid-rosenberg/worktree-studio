'use strict';
// Loads (and seeds on first run) ~/.config/worktree-studio/config.json.
// Reuses worktree-dash's config for baseDirs/start/editors when present so the
// two feel like one world.
const fs = require('fs');
const path = require('path');
const { HOME, expandTilde, readJson, writeJson } = require('./util');
const security = require('./security');

const CONFIG_DIR = process.env.WT_STUDIO_CONFIG_DIR || path.join(HOME, '.config', 'worktree-studio');
const CONFIG_FILE = process.env.WT_STUDIO_CONFIG || path.join(CONFIG_DIR, 'config.json');
const STATE_DIR = process.env.WT_STUDIO_STATE || path.join(HOME, '.local', 'state', 'worktree-studio');

const DASH_CONFIG = path.join(HOME, '.config', 'worktree-dash', 'config.json');

function defaults() {
  const dash = readJson(DASH_CONFIG, {}) || {};
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
    // Native `wt` copy-patterns (files git ignores get carried into new worktrees).
    copyPatterns: {
      default: ['.env', '.env.local', '.env.*.local', 'config/*-config.js', 'src/config.js', 'src/config/config.js'],
    },
    // per-repo dev-server launch config { cmd, ports }
    start: dash.start || {},
    // repos that serve a browsable frontend — get an "Open app ↗" button that
    // opens their (lsof-discovered) running port, incl. concurrency-shifted ports.
    webRepos: dash.webRepos || ['merchant-v3', 'ab-iso-fe', 'ab-su'],
    // manual feature groups: [{ name, members: ["repo/branch-or-wtname"] }]
    groups: dash.groups || [],
    // imported editor run/test configs: { "<repo>": [{ name, cmd, kind, source }] }
    runConfigs: dash.runConfigs || {},
    // pop-out target terminal (macOS). {name} is the mux session.
    popout: {
      terminal: 'Terminal',
      // command run to open a native window attached to a mux session
    },
    sources: {
      github: { enabled: true },
      gitlab: { enabled: false, host: 'https://gitlab.com', token: '' },
      asana: { enabled: false, token: '', workspace: '' },
    },
    // attention notifications when a session changes state (see public/app.js)
    notify: { waiting: true, sound: true, idle: false },
    // run 2–3 features at once: each feature gets a slot (0,1,2…); slot n offsets
    // every dev-server port by n*offsetStep and sets redis__db to n. Slot 0 ==
    // today's defaults (zero behavior change). accept-blue reads these via nconf's
    // `__`-nested env override; no backend code change needed.
    concurrency: {
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
          configPatch: { file: 'src/config.js', siblingRepo: 'accept-blue' },
        },
        'ab-iso-fe': {
          portEnv: { WTS_FE_PORT: 9000 }, // webpack-dev-server; iso 1232 + merchant 1239
          configPatch: { file: 'src/config/config.js', siblingRepo: 'accept-blue' },
        },
        'ab-su': {
          portEnv: { WTS_FE_PORT: 8000 }, // vite; su 1231 + merchant 1239 + iso 1232
          configPatch: { file: 'src/config/config.js', siblingRepo: 'accept-blue' },
        },
      },
    },
  };
}

// Non-fatal sanity check of the concurrency block (this is a local dev tool — warn,
// never throw). Flags two footguns:
//   - maxSlots > 16: redis__db is set to the slot index; redis ships 16 DBs (0..15),
//     so slots >= 16 would collide on the redis DB index.
//   - port-family collisions: within slots 0..maxSlots-1, family i at slot a and family j
//     at slot b land on the same port when base_i - base_j == (b-a)*offsetStep. That happens
//     iff |base_i - base_j| is a multiple of offsetStep no larger than (maxSlots-1)*offsetStep.
function validateConcurrency(cfg) {
  const c = cfg && cfg.concurrency;
  if (!c || !c.enabled) return;
  const step = c.offsetStep;
  const max = c.maxSlots || 1;
  if (max > 16) {
    console.warn(`[wt-studio] concurrency.maxSlots=${max} exceeds 16 (redis DB index limit); slots >= 16 collide on redis__db.`);
  }
  for (const [repo, rc] of Object.entries(c.repos || {})) {
    const bases = Object.values((rc && rc.portEnv) || {});
    for (let i = 0; i < bases.length; i++) {
      for (let j = i + 1; j < bases.length; j++) {
        const diff = Math.abs(bases[i] - bases[j]);
        if (step > 0 && diff % step === 0 && diff / step <= max - 1) {
          console.warn(`[wt-studio] concurrency: repo '${repo}' ports ${bases[i]} and ${bases[j]} collide across slots 0..${max - 1} `
            + `at offsetStep ${step} (diff ${diff} is a multiple of the step within slot range); increase offsetStep or reduce maxSlots.`);
        }
      }
    }
  }
}

function load() {
  let cfg = readJson(CONFIG_FILE, null);
  if (!cfg) {
    cfg = defaults();
    writeJson(CONFIG_FILE, cfg);
  } else {
    // shallow-merge missing top-level keys from defaults (forward-compat)
    const d = defaults();
    for (const k of Object.keys(d)) if (!(k in cfg)) cfg[k] = d[k];
    if (!cfg.web) cfg.web = d.web;
    if (!cfg.web.port) cfg.web.port = d.web.port;
    // Targeted deep-merge for copyPatterns.default only: the shallow merge above skips
    // it whenever the on-disk config already has a (possibly stale) copyPatterns key, so
    // newly-shipped default patterns would never reach existing users. Union the shipped
    // defaults into the user's default array (de-duped, user's extra patterns kept).
    // Per-repo overrides under copyPatterns are left untouched.
    cfg.copyPatterns = cfg.copyPatterns || {};
    cfg.copyPatterns.default = [...new Set([...(cfg.copyPatterns.default || []), ...d.copyPatterns.default])];
  }
  cfg._file = CONFIG_FILE;
  cfg._stateDir = STATE_DIR;
  cfg.baseDirs = (cfg.baseDirs || []).map(expandTilde);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // The boot token lives beside the state, not in config.json — config.json is a file
  // the user opens and edits (SwiftBar even has an "Edit config…" item). `_`-prefixed
  // keys are stripped by save(), so it can ride on cfg and reach sessions.js/status.js
  // without a second plumbing path.
  cfg._token = security.loadToken(STATE_DIR);
  validateConcurrency(cfg);
  return cfg;
}

// Persist config back to disk (strips internal _-prefixed runtime keys).
function save(cfg) {
  const out = {};
  for (const k of Object.keys(cfg)) if (!k.startsWith('_')) out[k] = cfg[k];
  writeJson(cfg._file || CONFIG_FILE, out);
}

module.exports = { load, save, validateConcurrency, CONFIG_FILE, CONFIG_DIR, STATE_DIR };
