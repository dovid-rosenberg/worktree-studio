'use strict';
// Loads (and seeds on first run) ~/.config/worktree-studio/config.json.
// Reuses worktree-dash's config for baseDirs/start/editors when present so the
// two feel like one world.
const fs = require('fs');
const path = require('path');
const { HOME, expandTilde, readJson, writeJson, has } = require('./util');

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
    // "auto" prefers zellij when installed, else tmux.
    multiplexer: 'auto',
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
  // resolve multiplexer
  if (cfg.multiplexer === 'auto') {
    cfg._mux = has('zellij') ? 'zellij' : (has('tmux') ? 'tmux' : 'none');
  } else {
    cfg._mux = cfg.multiplexer;
  }
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
