/*
 * View state that is the client's alone — nothing here comes from the daemon.
 *
 * app.js kept these as bare module globals and called render() after every write. The
 * runes below are the same values; the re-render is what disappears.
 *
 * ---------------------------------------------------------------------------------
 * WHY THE RAIL IS KEYED ON FEATURES, NOT SESSIONS.
 *
 * It used to iterate `world.sessions` and bucket by `s.worktree`. That shape cannot
 * express a worktree with no session — there is no object to render — so half the
 * worktrees on disk were invisible in Work and you had to switch to Fleet to see them.
 * The rail now iterates `world.features` and treats the session as decoration on a
 * feature, which is the same unit Fleet always used. Fleet itself survives verbatim as
 * the Overview dock pane; nothing about it was rewritten.
 *
 * Two behaviours came across with the rows and are easy to drop by accident:
 *
 *   ORDERING. Fleet sorted active-first, then alphabetical, so that "a feature does not
 *   jump around the list the moment its stack starts" (Fleet.svelte). The rail had no
 *   ordering at all — Map insertion order — so without `sortFeatures` below, rows
 *   visibly reshuffle every time an agent changes state. Nothing fails loudly; it just
 *   feels broken.
 *
 *   FILTERING. `repoFilter` used to test one session's `repoName`. A feature has several
 *   member repos, so it now matches if ANY member matches, and renders WHOLE. Showing
 *   only the matching members would split a BE+FE feature in half, which is precisely
 *   the grouping the shared-worktree-name convention exists to create.
 */

import { SvelteSet } from 'svelte/reactivity';
import { world } from '$lib/stores/world.svelte.js';

const DOCK_KEY = 'wts-dock';
const RAIL_KEY = 'wts-rail-w';

/** Drag bounds for the rail. Below ~230 the member chips stop being readable. */
export const RAIL_MIN = 230;
export const RAIL_MAX = 560;
const RAIL_DEFAULT = 320;

/**
 * The app-level views — the two that render with nothing selected. Everything else in
 * DockView is a panel of the selected session.
 * @typedef {'term'|'changes'|'logs'|'insights'|'overview'|'usage'} DockView
 */
const APP_VIEWS = ['overview', 'usage'];

/** @returns {DockView} */
function savedDock() {
  try {
    const v = localStorage.getItem(DOCK_KEY);
    return APP_VIEWS.includes(String(v)) ? /** @type {DockView} */ (v) : 'term';
  } catch { return 'term'; }
}

/** @returns {number} */
function savedRailWidth() {
  try {
    const n = Number(localStorage.getItem(RAIL_KEY));
    return Number.isFinite(n) && n >= RAIL_MIN && n <= RAIL_MAX ? n : RAIL_DEFAULT;
  } catch { return RAIL_DEFAULT; }
}

/**
 * Active = a live agent or a running dev server. Ported from Fleet.svelte, where it is
 * the sort key; it is the only thing that decides whether a feature sits at the top.
 * @param {any} f
 */
export function featureActive(f) {
  return (f.members || []).some(
    (/** @type {any} */ m) => m && !m.missing && (m.running || (m.session && m.session.state !== 'stopped')),
  );
}

/**
 * Fleet's ordering, verbatim: active first, then alphabetical. Returns a new array.
 * @param {any[]} list
 */
export function sortFeatures(list) {
  return list.slice().sort(
    (/** @type {any} */ a, /** @type {any} */ b) =>
      (Number(featureActive(b)) - Number(featureActive(a))) || String(a.name).localeCompare(String(b.name)),
  );
}

/** Members that actually exist on disk. @param {any} f */
export function liveMembers(f) {
  return (f.members || []).filter((/** @type {any} */ m) => m && !m.missing);
}

class UI {
  /** Selected session id, or null. */
  selectedId = $state(/** @type {string|null} */ (null));
  /**
   * Selected feature NAME, set only when the picked feature has no session — there is no
   * session id to hold in that case, and the dock shows the feature pane instead of a
   * terminal. Exactly one of these two is ever non-null.
   */
  selectedFeatureName = $state(/** @type {string|null} */ (null));
  /** Rail repo filter — '' means all repos. */
  repoFilter = $state('');
  /**
   * Which dock panel is showing. 'term' keeps the live terminal mounted; 'overview' is
   * the old Fleet view, now a pane, and is the one value that renders with no selection.
   */
  dockView = $state(/** @type {DockView} */ (savedDock()));
  /** Rail width in px — dragged by the splitter, persisted, clamped to [MIN, MAX]. */
  railWidth = $state(savedRailWidth());
  /** Active multiplexer window index within the primary session. */
  activeTab = $state(0);
  /**
   * Session ids whose split pane is engaged. A Set (not a boolean) because the split
   * persists per session across selection changes, exactly as app.js's splitSessions did.
   */
  splitSessions = new SvelteSet();

  /** The selected session object, or null. Follows the live `sessions` list. */
  selected = $derived(this.selectedId ? world.session(this.selectedId) : null);

  /** The selected sessionless feature, or null. Follows the live `features` list. */
  selectedFeature = $derived(
    this.selectedFeatureName
      ? (world.features.find((/** @type {any} */ f) => f.name === this.selectedFeatureName) || null)
      : null,
  );

  /** @param {any} f */
  #featureMatches = (f) => !this.repoFilter
    || (f.members || []).some((/** @type {any} */ m) => m && m.repo === this.repoFilter);

  /** Features after the repo filter, in Fleet's order. Whole features, never split. */
  visibleFeatures = $derived(sortFeatures(world.features.filter(this.#featureMatches)));

  /** Features with at least one dev server up. Deliberately ALSO listed under worktrees. */
  serverFeatures = $derived(
    this.visibleFeatures.filter((/** @type {any} */ f) => liveMembers(f).some((/** @type {any} */ m) => m.running)),
  );

  /**
   * Unpromoted sessions — no worktree, so no feature to sit under. Stopped/deactivated
   * ones linger, sorted after the live ones, as Fleet listed them.
   */
  visibleAgents = $derived(
    world.sessions
      .filter((/** @type {any} */ s) => !s.worktreePath && (!this.repoFilter || s.repoName === this.repoFilter))
      .slice()
      .sort((/** @type {any} */ a, /** @type {any} */ b) =>
        (Number(a.state === 'stopped') - Number(b.state === 'stopped'))
        || String(a.title || '').localeCompare(String(b.title || ''))),
  );

  /**
   * Dev servers running from a repo's MAIN checkout. Not a worktree, therefore not a
   * feature, therefore in no other list — without this they are a mystery port.
   */
  visibleMainServers = $derived((() => {
    const web = new Set(world.webRepos || []);
    return world.repos
      .flatMap((/** @type {any} */ r) => r.worktrees || [])
      .filter((/** @type {any} */ w) => w.isMain && web.has(w.repo) && w.running && (w.ports || []).length)
      .filter((/** @type {any} */ w) => !this.repoFilter || w.repo === this.repoFilter);
  })());

  /**
   * What ⌘1–9 picks, in the order the rail draws it. Agents first (they are the things
   * awaiting a decision), then every feature.
   */
  railOrder = $derived([
    ...this.visibleAgents.map((/** @type {any} */ s) => ({ kind: /** @type {const} */ ('session'), id: s.id, name: s.title })),
    ...this.visibleFeatures.map((/** @type {any} */ f) => ({ kind: /** @type {const} */ ('feature'), id: f.session ? f.session.id : null, name: f.name })),
  ]);

  /** Repo names offered by the filter: every member repo, plus unpromoted sessions' repos. */
  repoNames = $derived([...new Set([
    ...world.features.flatMap((/** @type {any} */ f) => (f.members || []).map((/** @type {any} */ m) => m.repo)),
    ...world.sessions.map((/** @type {any} */ s) => s.repoName),
  ])].filter(Boolean).sort());

  /** True when nothing at all is selected — the dock shows its empty state. */
  nothingSelected = $derived(!this.selected && !this.selectedFeature);

  /** True while an app-level view (Overview / Insights) owns the dock. */
  appView = $derived(APP_VIEWS.includes(this.dockView));

  /** @param {DockView} v */
  setDockView(v) {
    this.dockView = v;
    // Only the app-level views are worth persisting: the panel views belong to a
    // session and reset on selection anyway.
    try { localStorage.setItem(DOCK_KEY, APP_VIEWS.includes(v) ? v : 'term'); } catch { /* private mode */ }
  }

  /** ⌘\ — Overview is a pane you toggle, not a mode you get stuck in. */
  toggleOverview() {
    this.setDockView(this.dockView === 'overview' ? 'term' : 'overview');
  }

  /** Fleet-wide token/cost telemetry, as a peer of Overview. */
  toggleUsage() {
    this.setDockView(this.dockView === 'usage' ? 'term' : 'usage');
  }

  /** @param {number} px */
  setRailWidth(px) {
    this.railWidth = Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.round(px)));
    try { localStorage.setItem(RAIL_KEY, String(this.railWidth)); } catch { /* private mode */ }
  }

  /** @param {string} id */
  select(id) {
    if (this.selectedId === id && !this.selectedFeatureName) return;
    this.selectedId = id;
    this.selectedFeatureName = null;
    // Per-session dock state resets with the selection, as it did in rebuildDock().
    this.dockView = 'term';
    this.activeTab = 0;
  }

  /**
   * Pick a feature. One with an agent behaves exactly as picking that session did; one
   * without has no terminal to show, so the dock renders the feature pane instead.
   * @param {any} f
   */
  selectFeature(f) {
    if (f && f.session && f.session.id) { this.select(f.session.id); return; }
    this.selectedFeatureName = f ? f.name : null;
    this.selectedId = null;
    this.dockView = 'term';
    this.activeTab = 0;
  }

  /** @param {string} id */
  goToSession(id) {
    this.select(id);
    // Leaving an app-level view up would hide the session we were just asked to go to.
    if (APP_VIEWS.includes(this.dockView)) this.setDockView('term');
  }

  /** @param {string} id */
  splitOn(id) { return this.splitSessions.has(id); }

  /** @param {string} id */
  toggleSplit(id) {
    if (this.splitSessions.has(id)) this.splitSessions.delete(id);
    else this.splitSessions.add(id);
  }
}

/** @param {any} s */
export function labelForSource(s) {
  if (s.source === 'github') return `GH#${s.sourceId}`;
  if (s.source === 'gitlab') return `GL!${s.sourceId}`;
  if (s.source === 'asana') return 'Asana';
  return s.source;
}

export const ui = new UI();
