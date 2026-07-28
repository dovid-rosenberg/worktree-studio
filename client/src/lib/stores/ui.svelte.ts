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
import type { Feature, FeatureMember, Session, Worktree } from '../../../../server/types';

/** A member that survived the on-disk check — `missing` rows are filtered out first. */
export type LiveMember = Worktree;

/**
 * One ⌘1–9 target. `id` is null for a feature with no agent — there is no session to
 * jump to, so the caller selects the feature by name instead.
 */
export interface RailEntry {
  kind: 'session' | 'feature';
  id: string | null;
  name: string;
}

const DOCK_KEY = 'wts-dock';
const RAIL_KEY = 'wts-rail-w';

/** Drag bounds for the rail. Below ~230 the member chips stop being readable. */
export const RAIL_MIN = 230;
export const RAIL_MAX = 560;
const RAIL_DEFAULT = 320;

/**
 * The app-level views are the two that render with nothing selected. Everything else
 * in DockView is a panel of the selected session.
 */
export type DockView = 'term' | 'changes' | 'logs' | 'insights' | 'overview' | 'usage';
const APP_VIEWS: DockView[] = ['overview', 'usage'];

function savedDock(): DockView {
  try {
    const v = localStorage.getItem(DOCK_KEY);
    return APP_VIEWS.includes(v as DockView) ? (v as DockView) : 'term';
  } catch { return 'term'; }
}

function savedRailWidth(): number {
  try {
    const n = Number(localStorage.getItem(RAIL_KEY));
    return Number.isFinite(n) && n >= RAIL_MIN && n <= RAIL_MAX ? n : RAIL_DEFAULT;
  } catch { return RAIL_DEFAULT; }
}

/**
 * Active = a live agent or a running dev server. Ported from Fleet.svelte, where it is
 * the sort key; it is the only thing that decides whether a feature sits at the top.
 */
export function featureActive(f: Feature): boolean {
  return (f.members || []).some((m: FeatureMember) => {
    if (!m || ('missing' in m && m.missing)) return false;
    const w = m as Worktree;
    return Boolean(w.running || (w.session && w.session.state !== 'stopped'));
  });
}

/** Fleet's ordering, verbatim: active first, then alphabetical. Returns a new array. */
export function sortFeatures(list: Feature[]): Feature[] {
  return list.slice().sort(
    (a, b) => (Number(featureActive(b)) - Number(featureActive(a))) || String(a.name).localeCompare(String(b.name)),
  );
}

/** Members that actually exist on disk. */
export function liveMembers(f: Feature): LiveMember[] {
  return (f.members || []).filter(
    (m: FeatureMember): m is Worktree => Boolean(m) && !('missing' in m && m.missing),
  );
}

class UI {
  /** Selected session id, or null. */
  selectedId = $state<string | null>(null);
  /**
   * Selected feature NAME, set only when the picked feature has no session — there is no
   * session id to hold in that case, and the dock shows the feature pane instead of a
   * terminal. Exactly one of these two is ever non-null.
   */
  selectedFeatureName = $state<string | null>(null);
  /** Rail repo filter — '' means all repos. */
  repoFilter = $state('');
  /**
   * Which dock panel is showing. 'term' keeps the live terminal mounted; 'overview' is
   * the old Fleet view, now a pane, and is the one value that renders with no selection.
   */
  dockView = $state<DockView>(savedDock());
  /** Rail width in px — dragged by the splitter, persisted, clamped to [MIN, MAX]. */
  railWidth = $state(savedRailWidth());
  /**
   * The selected multiplexer window's ID within the primary session — not its position.
   * tmux renumbers windows when one closes, so an index held across a close selects a
   * different terminal than the one the strip is highlighting. Empty string means
   * "whatever the session's first tab is", resolved at render.
   */
  activeTabId = $state('');
  /**
   * Session ids whose split pane is engaged. A Set (not a boolean) because the split
   * persists per session across selection changes, exactly as app.js's splitSessions did.
   */
  splitSessions = new SvelteSet<string>();

  /** The selected session object, or null. Follows the live `sessions` list. */
  selected = $derived(this.selectedId ? world.session(this.selectedId) : null);

  /** The selected sessionless feature, or null. Follows the live `features` list. */
  selectedFeature = $derived(
    this.selectedFeatureName
      ? (world.features.find((f) => f.name === this.selectedFeatureName) || null)
      : null,
  );

  #featureMatches = (f: Feature): boolean => !this.repoFilter
    // A MissingMember is a dangling config reference with no repo, so it can never
    // match a filter — guard on the discriminant rather than casting it away.
    || (f.members || []).some((m) => Boolean(m) && !('missing' in m && m.missing)
      && (m as Worktree).repo === this.repoFilter);

  /** Features after the repo filter, in Fleet's order. Whole features, never split. */
  visibleFeatures = $derived(sortFeatures(world.features.filter(this.#featureMatches)));

  /** Features with at least one dev server up. Deliberately ALSO listed under worktrees. */
  serverFeatures = $derived(
    this.visibleFeatures.filter((f) => liveMembers(f).some((m) => m.running)),
  );

  /**
   * Unpromoted sessions — no worktree, so no feature to sit under. Stopped/deactivated
   * ones linger, sorted after the live ones, as Fleet listed them.
   */
  visibleAgents = $derived(
    world.sessions
      .filter((s) => !s.worktreePath && (!this.repoFilter || s.repoName === this.repoFilter))
      .slice()
      .sort((a, b) =>
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
      .flatMap((r) => r.worktrees || [])
      .filter((w) => w.isMain && web.has(w.repo) && w.running && (w.ports || []).length)
      .filter((w) => !this.repoFilter || w.repo === this.repoFilter);
  })());

  /**
   * What ⌘1–9 picks, in the order the rail draws it. Agents first (they are the things
   * awaiting a decision), then every feature.
   */
  railOrder = $derived<RailEntry[]>([
    ...this.visibleAgents.map((s) => ({ kind: 'session' as const, id: s.id, name: s.title })),
    ...this.visibleFeatures.map((f) => ({ kind: 'feature' as const, id: f.session ? f.session.id : null, name: f.name })),
  ]);

  /** Repo names offered by the filter: every member repo, plus unpromoted sessions' repos. */
  repoNames = $derived([...new Set([
    ...world.features.flatMap((f) => liveMembers(f).map((m) => m.repo)),
    ...world.sessions.map((s) => s.repoName),
  ])].filter(Boolean).sort());

  /** True when nothing at all is selected — the dock shows its empty state. */
  nothingSelected = $derived(!this.selected && !this.selectedFeature);

  /** True while an app-level view (Overview / Insights) owns the dock. */
  appView = $derived(APP_VIEWS.includes(this.dockView));

  setDockView(v: DockView): void {
    this.dockView = v;
    // Only the app-level views are worth persisting: the panel views belong to a
    // session and reset on selection anyway.
    try { localStorage.setItem(DOCK_KEY, APP_VIEWS.includes(v) ? v : 'term'); } catch { /* private mode */ }
  }

  /** ⌘\ — Overview is a pane you toggle, not a mode you get stuck in. */
  toggleOverview(): void {
    this.setDockView(this.dockView === 'overview' ? 'term' : 'overview');
  }

  /** Fleet-wide token/cost telemetry, as a peer of Overview. */
  toggleUsage(): void {
    this.setDockView(this.dockView === 'usage' ? 'term' : 'usage');
  }

  setRailWidth(px: number): void {
    this.railWidth = Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.round(px)));
    try { localStorage.setItem(RAIL_KEY, String(this.railWidth)); } catch { /* private mode */ }
  }

  select(id: string): void {
    if (this.selectedId === id && !this.selectedFeatureName) return;
    this.selectedId = id;
    this.selectedFeatureName = null;
    // Per-session dock state resets with the selection, as it did in rebuildDock().
    this.dockView = 'term';
    this.activeTabId = '';
  }

  /**
   * Pick a feature. One with an agent behaves exactly as picking that session did; one
   * without has no terminal to show, so the dock renders the feature pane instead.
   */
  selectFeature(f: Feature | null | undefined): void {
    if (f && f.session && f.session.id) { this.select(f.session.id); return; }
    this.selectedFeatureName = f ? f.name : null;
    this.selectedId = null;
    this.dockView = 'term';
    this.activeTabId = '';
  }

  goToSession(id: string): void {
    this.select(id);
    // Leaving an app-level view up would hide the session we were just asked to go to.
    if (APP_VIEWS.includes(this.dockView)) this.setDockView('term');
  }

  splitOn(id: string): boolean { return this.splitSessions.has(id); }

  toggleSplit(id: string): void {
    if (this.splitSessions.has(id)) this.splitSessions.delete(id);
    else this.splitSessions.add(id);
  }
}

export function labelForSource(s: Pick<Session, 'source' | 'sourceId'>): string {
  if (s.source === 'github') return `GH#${s.sourceId}`;
  if (s.source === 'gitlab') return `GL!${s.sourceId}`;
  if (s.source === 'asana') return 'Asana';
  return s.source;
}

export const ui = new UI();
