'use strict';
// Loads (and seeds on first run) ~/.config/worktree-studio/config.json.
// Reuses worktree-dash's config for baseDirs/start/editors when present so the
// two feel like one world.
const fs = require('fs');
const path = require('path');
const { HOME, expandTilde, readJson, writeJson } = require('./util');

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
      default: ['.env', '.env.local', '.env.*.local', 'config/*-config.js'],
    },
    // per-repo dev-server launch config { cmd, ports }
    start: dash.start || {},
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
        'merchant-v3': {
          portEnv: { WTS_FE_PORT: 3030 },
          // The FE's BE URL is hardcoded to accept-blue's slot-0 merchant port in the
          // gitignored, per-worktree src/config.js. On stack-start Studio rewrites that
          // file's localhost:<merchant-port-family> to this feature's slot port.
          configPatch: { file: 'src/config.js', siblingRepo: 'accept-blue', siblingPortKey: 'api__port_merchant' },
        },
      },
    },
  };
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
  }
  cfg._file = CONFIG_FILE;
  cfg._stateDir = STATE_DIR;
  cfg.baseDirs = (cfg.baseDirs || []).map(expandTilde);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  return cfg;
}

// Persist config back to disk (strips internal _-prefixed runtime keys).
function save(cfg) {
  const out = {};
  for (const k of Object.keys(cfg)) if (!k.startsWith('_')) out[k] = cfg[k];
  writeJson(cfg._file || CONFIG_FILE, out);
}

module.exports = { load, save, CONFIG_FILE, CONFIG_DIR, STATE_DIR };
