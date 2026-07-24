'use strict';
// The multiplexer driver. tmux only — it's the substrate that gives clean
// embedded tabs and a grouped pop-out that never orphans the embedded client.
const tmux = require('./tmux');

// Returns the tmux driver if tmux is installed, else null.
async function select() {
  return (await tmux.available()) ? tmux : null;
}

module.exports = { select, tmux };
