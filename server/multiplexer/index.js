'use strict';
// Selects a multiplexer driver. Honors config.multiplexer ("zellij" | "tmux" |
// "auto"); for "auto" it prefers zellij, but only after a live self-test — if
// the preferred driver can't actually create a session, it falls back so the
// app always works.
const tmux = require('./tmux');
const zellij = require('./zellij');

const DRIVERS = { tmux, zellij };

async function select(pref = 'auto') {
  const order = pref === 'tmux' ? ['tmux', 'zellij']
    : pref === 'zellij' ? ['zellij', 'tmux']
      : ['zellij', 'tmux']; // auto
  for (const key of order) {
    const d = DRIVERS[key];
    if (!(await d.available())) continue;
    if (await d.selfTest()) return d;
  }
  // last resort: return the first available even if self-test failed
  for (const key of order) if (await DRIVERS[key].available()) return DRIVERS[key];
  return null;
}

module.exports = { select, DRIVERS };
