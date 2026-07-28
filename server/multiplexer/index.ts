// The multiplexer driver. tmux only — it's the substrate that gives clean
// embedded tabs and a grouped pop-out that never orphans the embedded client.
import tmux from './tmux.ts';
import type { TmuxDriver } from './tmux.ts';

// Returns the tmux driver if tmux is installed, else null.
async function select(): Promise<TmuxDriver | null> {
  return (await tmux.available()) ? tmux : null;
}

export { select, tmux };
