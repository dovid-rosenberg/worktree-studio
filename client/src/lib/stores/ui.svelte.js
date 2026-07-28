/*
 * View state that is the client's alone — nothing here comes from the daemon.
 *
 * app.js kept these as bare module globals and called render() after every write. The
 * runes below are the same values; the re-render is what disappears.
 */

import { SvelteSet } from 'svelte/reactivity';
import { world } from '$lib/stores/world.svelte.js';

const VIEW_KEY = 'wts-view';

/** @returns {'work'|'fleet'} */
function savedView() {
  try {
    return localStorage.getItem(VIEW_KEY) === 'fleet' ? 'fleet' : 'work';
  } catch { return 'work'; }
}

class UI {
  /** 'work' (rail + dock) or 'fleet' (the terminal-free manager). */
  view = $state(/** @type {'work'|'fleet'} */ (savedView()));
  /** Selected session id, or null for the empty state. */
  selectedId = $state(/** @type {string|null} */ (null));
  /** Rail repo filter — '' means all repos. */
  repoFilter = $state('');
  /** Which dock panel is showing. 'term' keeps the live terminal mounted. */
  dockView = $state(/** @type {'term'|'changes'|'logs'|'insights'} */ ('term'));
  /** Active multiplexer window index within the primary session. */
  activeTab = $state(0);
  /**
   * Session ids whose split pane is engaged. A Set (not a boolean) because the split
   * persists per session across selection changes, exactly as app.js's splitSessions did.
   */
  splitSessions = new SvelteSet();

  /** The selected session object, or null. Follows the live `sessions` list. */
  selected = $derived(this.selectedId ? world.session(this.selectedId) : null);

  /** Sessions after the repo filter. */
  visibleSessions = $derived(
    world.sessions.filter((/** @type {any} */ s) => !this.repoFilter || s.repoName === this.repoFilter),
  );

  /**
   * The rail's display order: promoted sessions clustered by their worktree (feature),
   * unpromoted ones loose after. Shared by the rail and by ⌘1–9 so the Nth shortcut
   * always picks the Nth card as drawn.
   */
  railGroups = $derived(groupRail(this.visibleSessions));
  railOrder = $derived([
    ...this.railGroups.features.flatMap((/** @type {any} */ g) => g.members),
    ...this.railGroups.loose,
  ]);

  /** Repo names offered by the rail filter. */
  repoNames = $derived([...new Set(world.sessions.map((/** @type {any} */ s) => s.repoName))]);

  /** @param {'work'|'fleet'} v */
  setView(v) {
    this.view = v;
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ }
  }

  /** @param {string} id */
  select(id) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    // Per-session dock state resets with the selection, as it did in rebuildDock().
    this.dockView = 'term';
    this.activeTab = 0;
  }

  /** @param {string} id */
  goToSession(id) {
    this.select(id);
    this.setView('work');
  }

  /** @param {string} id */
  splitOn(id) { return this.splitSessions.has(id); }

  /** @param {string} id */
  toggleSplit(id) {
    if (this.splitSessions.has(id)) this.splitSessions.delete(id);
    else this.splitSessions.add(id);
  }
}

/**
 * Group sessions the way the rail displays them.
 * @param {any[]} sessions
 * @returns {{ features: {name:string, members:any[]}[], loose:any[] }}
 */
export function groupRail(sessions) {
  /** @type {Map<string, any[]>} */
  const byFeature = new Map();
  /** @type {any[]} */
  const loose = [];
  for (const s of sessions) {
    if (s.worktree) {
      if (!byFeature.has(s.worktree)) byFeature.set(s.worktree, []);
      /** @type {any[]} */ (byFeature.get(s.worktree)).push(s);
    } else {
      loose.push(s);
    }
  }
  return { features: [...byFeature].map(([name, members]) => ({ name, members })), loose };
}

/** @param {any} s */
export function labelForSource(s) {
  if (s.source === 'github') return `GH#${s.sourceId}`;
  if (s.source === 'gitlab') return `GL!${s.sourceId}`;
  if (s.source === 'asana') return 'Asana';
  return s.source;
}

export const ui = new UI();
