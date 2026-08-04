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
 * worktrees on disk were simply invisible.
 * The rail now iterates `world.features` and treats the session as decoration on a
 * feature.
 *
 * Two behaviours came across with the rows and are easy to drop by accident:
 *
 *   ORDERING. Active first, then alphabetical, so that a feature does not jump around
 *   the list the moment its stack starts. The rail had no
 *   ordering at all — Map insertion order — so without `sortFeatures` below, rows
 *   visibly reshuffle every time an agent changes state. Nothing fails loudly; it just
 *   feels broken.
 *
 *   FILTERING. `repoFilter` used to test one session's `repoName`. A feature has several
 *   member repos, so it now matches if ANY member matches, and renders WHOLE. Showing
 *   only the matching members would split a BE+FE feature in half, which is precisely
 *   the grouping the shared-worktree-name convention exists to create.
 */

import { world } from '$lib/stores/world.svelte.js';
import type { Feature, FeatureMember, Session, Worktree } from '../../../../server/types';

/** A member that survived the on-disk check — `missing` rows are filtered out first. */
export type LiveMember = Worktree;

/**
 * One ⌘1–9 target. `id` is null for a feature with no agent — there is no session to
 * jump to, so the caller selects the feature by name instead.
 */
/**
 * One row of the rail, whatever kind of thing it is. `active` is the single sort key:
 * a live agent, or a running dev server.
 */
export type RailRow =
  | { kind: 'session'; key: string; name: string; session: Session; active: boolean }
  | { kind: 'mainserver'; key: string; name: string; worktree: Worktree; active: boolean }
  | { kind: 'feature'; key: string; name: string; feature: Feature; active: boolean };

export interface RailEntry {
  kind: 'session' | 'feature';
  id: string | null;
  name: string;
}

/**
 * What is selected, as ONE value.
 *
 * The three kinds are the three kinds of rail row, so "what is selected" and "what is
 * highlighted" cannot disagree. `null` is nothing selected — a state the old pair of
 * fields could also express three different ways.
 */
export type Selection =
  | { kind: 'session'; id: string }
  | { kind: 'feature'; name: string }
  | { kind: 'mainserver'; path: string }
  | null;

const DOCK_KEY = 'wts-dock';
const RAIL_KEY = 'wts-rail-w';

/** Drag bounds for the rail. Below this the member chips stop being readable — the floor
    moved with the type scale, which went up a point across the app. */
export const RAIL_MIN = 250;
export const RAIL_MAX = 560;
const RAIL_DEFAULT = 320;

/**
 * `usage` (Insights) is the one view that renders with nothing selected — it is about
 * every session that ever ran. Everything else is a panel of the selected session.
 *
 * This used to be an APP_VIEWS array with `includes()` checks at four call sites, which
 * made sense when Overview was the second entry. Overview is gone; a one-element array is
 * machinery around a single comparison.
 */
export type DockView = 'term' | 'changes' | 'logs' | 'usage';

function savedDock(): DockView {
  // Only Insights is worth restoring: the panel views belong to a session and reset with
  // the selection anyway.
  try { return localStorage.getItem(DOCK_KEY) === 'usage' ? 'usage' : 'term'; } catch { return 'term'; }
}

function savedRailWidth(): number {
  try {
    const n = Number(localStorage.getItem(RAIL_KEY));
    return Number.isFinite(n) && n >= RAIL_MIN && n <= RAIL_MAX ? n : RAIL_DEFAULT;
  } catch { return RAIL_DEFAULT; }
}

/**
 * Active = a live agent or a running dev server. The rail's only sort key, and the only
 * thing that decides whether a feature sits at the top.
 */
export function featureActive(f: Feature): boolean {
  return (f.members || []).some((m: FeatureMember) => {
    if (!m || ('missing' in m && m.missing)) return false;
    const w = m as Worktree;
    return Boolean(w.running || (w.session && w.session.state !== 'stopped'));
  });
}

/** Active first, then alphabetical. Returns a new array. */
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
  /**
   * WHAT IS SELECTED — one value, not one field per kind.
   *
   * This was two fields (`selectedId` and `selectedFeatureName`) carrying an invariant
   * that exactly one was non-null, maintained by convention in four methods. Convention
   * lost: a call site set `selectedId` without clearing `selectedFeatureName`, the dock
   * tests the feature first, and starting an agent from a sessionless feature left the
   * feature table on screen while the terminal it had just created was hidden behind it.
   *
   * A tagged value cannot express that state at all, which is why the tests for it are
   * gone rather than expanded. `selectedId` / `selectedFeatureName` survive below as
   * READ-ONLY projections, so the components that only ask "is this me?" are unchanged.
   */
  selection = $state<Selection>(null);
  /** Rail repo filter — '' means all repos. */
  repoFilter = $state('');
  /** Which dock panel is showing. 'term' keeps the live terminal mounted. */
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
   * Which session Insights should open drilled into, if any.
   *
   * Insights used to be TWO destinations sharing one word and one glyph: a session-scoped
   * dock tab and a fleet-wide view. They are one now — an overview that drills down — and
   * this is how a caller (the palette's "Session insights") asks for a particular row
   * without the view needing a selection it has just been told to clear.
   */
  insightsFocus = $state<string | null>(null);

  /** Selected session id, or null. Read-only — go through select(). */
  get selectedId(): string | null { return this.selection?.kind === 'session' ? this.selection.id : null; }
  /** Selected sessionless feature's name, or null. Read-only — go through selectFeature(). */
  get selectedFeatureName(): string | null { return this.selection?.kind === 'feature' ? this.selection.name : null; }

  /** The selected session object, or null. Follows the live `sessions` list. */
  selected = $derived(this.selectedId ? world.session(this.selectedId) : null);

  /** The selected sessionless feature, or null. Follows the live `features` list. */
  selectedFeature = $derived(
    this.selectedFeatureName
      ? (world.features.find((f) => f.name === this.selectedFeatureName) || null)
      : null,
  );

  /**
   * The selected main-checkout dev server, or null.
   *
   * These rows used to be the ONLY ones in the rail carrying buttons — an admitted
   * exception to the rail's own rule — because they could not be selected, so the
   * ActionBar had nothing to act on. Making them a selection kind is what let their
   * Open ↗ / Stop join every other verb at the bottom.
   */
  selectedMainServer = $derived(
    this.selection?.kind === 'mainserver'
      ? (world.repos.flatMap((r) => r.worktrees || [])
          .find((w) => w.path === (this.selection as { path: string }).path) || null)
      : null,
  );

  #featureMatches = (f: Feature): boolean => !this.repoFilter
    // A MissingMember is a dangling config reference with no repo, so it can never
    // match a filter — guard on the discriminant rather than casting it away.
    || (f.members || []).some((m) => Boolean(m) && !('missing' in m && m.missing)
      && (m as Worktree).repo === this.repoFilter);

  /** Features after the repo filter, in rail order. Whole features, never split. */
  visibleFeatures = $derived(sortFeatures(world.features.filter(this.#featureMatches)));

  /** Features with at least one dev server up. */
  serverFeatures = $derived(
    this.visibleFeatures.filter((f) => liveMembers(f).some((m) => m.running)),
  );

  /**
   * Sessions with no worktree yet, so no feature to sit under. Stopped/deactivated ones
   * linger, sorted after the live ones.
   *
   * "Session", never "agent". The UI used both for one thing — "no agent" on a card,
   * "Start session" on the button beside it — and a reader cannot tell whether that is
   * one concept or two. `session` wins: it is already the URL, the state file and the type.
   */
  unpromotedSessions = $derived(
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
   * THE rail: one flat list, active first, then everything else.
   *
   * It used to be four sections — servers-running, main servers, agents, worktrees —
   * which rendered a running feature TWICE and gave the list four `position:sticky`
   * headers that collided in one scroller. The sections were also the wrong cut: a
   * bucket keyed on "running" mixes two unrelated facts (dev servers up, agent state),
   * so a *waiting* agent — the one row that actually wants you — would sit among stale
   * worktrees from last month.
   *
   * So: no buckets. `featureActive` sorts anything with a live agent or a running
   * server to the top, which is where a waiting agent belongs, and `dividerAt` marks
   * where the quiet ones begin. One row per thing, always.
   */
  railRows = $derived<RailRow[]>((() => {
    const rows: RailRow[] = [
      ...this.unpromotedSessions.map((s): RailRow => ({
        kind: 'session', key: `s:${s.id}`, name: s.title, session: s,
        active: s.state !== 'stopped',
      })),
      ...this.visibleMainServers.map((w): RailRow => ({
        kind: 'mainserver', key: `w:${w.path}`, name: w.repo, worktree: w, active: true,
      })),
      ...this.visibleFeatures.map((f): RailRow => ({
        kind: 'feature', key: `f:${f.name}`, name: f.name, feature: f, active: featureActive(f),
      })),
    ];
    // Active first, then alphabetical — the comparator the rail has always used, now
    // applied across every kind of row rather than within each section.
    return rows.sort((a, b) => (Number(b.active) - Number(a.active)) || a.name.localeCompare(b.name));
  })());

  /** Index of the first quiet row, or -1 when everything is active (or nothing is). */
  dividerAt = $derived(
    this.railRows.some((r) => r.active) ? this.railRows.findIndex((r) => !r.active) : -1,
  );

  /**
   * What ⌘1–9 picks, in the order the rail actually draws it.
   *
   * This used to be agents-then-features while the rail drew servers-running, main
   * servers, agents, then features — so with one running feature, ⌘1 hit the fourth
   * card on screen. A shortcut that selects something other than what you counted is
   * worse than no shortcut. It is built from the same sections the rail renders, with
   * the servers-running repeat de-duplicated so a feature never occupies two numbers.
   */
  railOrder = $derived<RailEntry[]>(
    this.railRows
      .filter((r) => r.kind !== 'mainserver') // nothing to select: it owns no session
      .map((r) => ({
        kind: r.kind === 'session' ? ('session' as const) : ('feature' as const),
        id: r.kind === 'session' ? r.session!.id : (r.feature?.session?.id ?? null),
        name: r.name,
      })),
  );

  /** Repo names offered by the filter: every member repo, plus unpromoted sessions' repos. */
  repoNames = $derived([...new Set([
    ...world.features.flatMap((f) => liveMembers(f).map((m) => m.repo)),
    ...world.sessions.map((s) => s.repoName),
  ])].filter(Boolean).sort());

  /** True when nothing at all is selected — the dock shows its empty state. */
  nothingSelected = $derived(!this.selected && !this.selectedFeature);

  /**
   * A session has been selected but has not arrived in the world yet.
   *
   * Selecting happens the moment the create/start call returns; the session only enters
   * `world.sessions` when the next `session-state` frame lands. In that window
   * `ui.selected` is null, and the dock used to render "No session selected" — so
   * starting an agent looked like it had done nothing, and the user clicked the rail to
   * "fix" it. It is a pending state, not an empty one.
   */
  selectionPending = $derived(!!this.selectedId && !this.selected);

  /** True while Insights owns the dock — i.e. the view that ignores the selection. */
  appView = $derived(this.dockView === 'usage');

  setDockView(v: DockView): void {
    this.dockView = v;
    try { localStorage.setItem(DOCK_KEY, v === 'usage' ? 'usage' : 'term'); } catch { /* private mode */ }
  }

  /**
   * Open Insights, optionally drilled into one session.
   *
   * Entering CLEARS the selection: Insights is about every session that ever ran, not the
   * one you happen to have open, and leaving a selection standing left the ActionBar
   * offering Stop stack / Delete feature for something no longer on screen.
   */
  openInsights(sessionId: string | null = null): void {
    this.insightsFocus = sessionId;
    this.selection = null;
    this.setDockView('usage');
  }

  toggleUsage(): void {
    if (this.dockView === 'usage') { this.setDockView('term'); return; }
    // Seed the drill-down with whatever is open, so opening Insights while looking at a
    // session lands on that session's breakdown rather than nowhere.
    this.openInsights(this.selectedId);
  }

  setRailWidth(px: number): void {
    this.railWidth = Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.round(px)));
    try { localStorage.setItem(RAIL_KEY, String(this.railWidth)); } catch { /* private mode */ }
  }

  /** Replace the selection and reset the per-selection dock state, as rebuildDock() did. */
  #pick(next: Selection): void {
    this.selection = next;
    this.dockView = 'term';
    this.activeTabId = '';
  }

  select(id: string): void {
    if (this.selection?.kind === 'session' && this.selection.id === id) return;
    this.#pick({ kind: 'session', id });
  }

  /**
   * Pick a feature. One with an agent behaves exactly as picking that session did; one
   * without has no terminal to show, so the dock renders the feature pane instead.
   */
  selectFeature(f: Feature | null | undefined): void {
    if (f?.session?.id) { this.select(f.session.id); return; }
    this.#pick(f ? { kind: 'feature', name: f.name } : null);
  }

  /** Pick a dev server running from a repo's main checkout. */
  selectMainServer(path: string): void {
    if (this.selection?.kind === 'mainserver' && this.selection.path === path) return;
    this.#pick({ kind: 'mainserver', path });
  }

  /** Nothing selected. */
  clearSelection(): void { this.selection = null; }

  goToSession(id: string): void {
    this.select(id);
    // Leaving Insights up would hide the session we were just asked to go to.
    if (this.dockView === 'usage') this.setDockView('term');
  }

}

export function labelForSource(s: Pick<Session, 'source' | 'sourceId'>): string {
  if (s.source === 'github') return `GH#${s.sourceId}`;
  if (s.source === 'gitlab') return `GL!${s.sourceId}`;
  if (s.source === 'asana') return 'Asana';
  return s.source;
}

export const ui = new UI();
