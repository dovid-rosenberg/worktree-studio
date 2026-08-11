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
import type {
  EmbeddedSession,
  Feature,
  FeatureMember,
  ReviewItem,
  Session,
  Worktree,
} from '../../../../server/types';

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
  | { kind: 'feature'; key: string; name: string; feature: Feature; active: boolean }
  | { kind: 'review'; key: string; name: string; review: ReviewItem; active: boolean };

/**
 * The agent driving a rail row, whichever kind of row it is.
 *
 * A row is one of three shapes, and the session lives in a different place in two of
 * them: `kind:'session'` is an UNPROMOTED session and carries it directly, while a
 * promoted one appears as `kind:'feature'` with the session embedded. Anything asking
 * "what is this agent doing" has to look in both, and the code that did not — the waiting
 * sort and the jump-to-next-waiting — silently covered only unpromoted sessions.
 *
 * That is close to nothing in practice: promoting is the normal path, so a fleet of ten
 * promoted features had a waiting badge that counted them and a button that could not
 * find a single one.
 */
export function rowSession(r: RailRow): EmbeddedSession | Session | null {
  if (r.kind === 'session') return r.session;
  if (r.kind === 'feature') return r.feature.session;
  return null;
}

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
  /** A merge request awaiting your review. `id` is `<repo>!<number>`. */
  | { kind: 'review'; id: string }
  | null;

/**
 * A stable key for a selection — THE encoder for the `s:` / `f:` / `w:` scheme.
 *
 * `null` maps to '', which is a key nothing is ever stored under, so "nothing was
 * selected" cannot accidentally share a slot with something that was.
 *
 * This scheme was spelled out independently in four places: here, three times inline in
 * railRows below, and twice more in deeplink.ts (once with encodeURIComponent, once
 * inverted). deeplink's own header asserts the coupling — "the fragment reuses the rail's
 * own key scheme instead of inventing a second vocabulary" — but the reuse was by
 * convention, and convention does not fail a build.
 *
 * The failure mode is silent: railDigits and goToNextWaiting both match a row's `key`
 * against selectionKey(selection). Change a prefix letter in one place and the rail
 * highlights nothing while ⌥-digit picks the wrong row, with no compile error anywhere.
 *
 * `enc` exists for the URL form, which needs its values escaped and its structure
 * identical — one encoder, two escapings.
 */
export function selectionKey(s: Selection, enc: (v: string) => string = (v) => v): string {
  if (!s) return '';
  if (s.kind === 'session') return `s:${enc(s.id)}`;
  if (s.kind === 'feature') return `f:${enc(s.name)}`;
  if (s.kind === 'review') return `r:${enc(s.id)}`;
  return `w:${enc(s.path)}`;
}

const DOCK_KEY = 'wts-dock';
const RAIL_KEY = 'wts-rail-w';
const SORT_KEY = 'wts-rail-sort';
const ROOT_KEY = 'wts-root';
const DRIFT_KEY = 'wts-drift-dismissed';

/**
 * A dismissed drift finding, identified by what it CLAIMS rather than by its branch.
 *
 * detectDrift() reports the same branch for as long as the two worktrees exist, so a
 * banner keyed on the branch alone would come back on every frame — and a pair you keep
 * apart on purpose (a spike alongside the real work, two repos that genuinely diverged)
 * would nag forever. Keyed on the branch AND the feature names, sorted, so dismissing
 * says "not these two" rather than "never mention this branch": a third worktree joining
 * the pair is a new claim and asks again.
 */
function driftKey(d: { branch: string; features: string[] }): string {
  // `|` rather than a space: a feature name is a directory basename, so it cannot
  // contain one — the key round-trips unambiguously and reads in a storage pane.
  return [d.branch, ...[...d.features].sort()].join('|');
}

function savedDrift(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(DRIFT_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * How the rail is ordered. `attention` is the default and the one the app is designed
 * around; the others exist because what you are looking FOR changes with what you are
 * doing — reviewing a board is a different question from finding the agent that stopped.
 */
export type RailSort = 'attention' | 'status' | 'running' | 'agent' | 'name';

export const RAIL_SORTS: Array<{ id: RailSort; label: string; hint: string }> = [
  { id: 'attention', label: 'Attention', hint: 'Waiting first, then anything active' },
  { id: 'status', label: 'Task status', hint: 'By the tracker’s own workflow order' },
  { id: 'running', label: 'Running', hint: 'Features with dev servers up first' },
  { id: 'agent', label: 'Agent state', hint: 'Waiting, working, idle, stopped' },
  { id: 'name', label: 'Name', hint: 'Alphabetical, and never moves' },
];

/**
 * Agent states in the order you care about them.
 *
 * `waiting` is blocked on YOU, `working` is progress you may want to watch, and the rest
 * are at rest. Numbers rather than a string compare, because alphabetical would put
 * `idle` above `waiting` — the exact inversion this ordering exists to prevent.
 */
const AGENT_RANK: Record<string, number> = { waiting: 0, working: 1, idle: 2, stopped: 3 };

/**
 * A tracker's own column order, as far as we can guess it.
 *
 * Trackers name their columns freely, so this matches on substrings and falls to the end
 * for anything unrecognised — a status we cannot place sorts after ones we can, rather
 * than jumbling in among them. Ranked by where work IS, not alphabetically: a board reads
 * in-progress → review → todo → backlog → done.
 */
const STATUS_ORDER = ['progress', 'review', 'todo', 'next', 'backlog', 'done'];

function statusRank(label: string | undefined): number {
  if (!label) return STATUS_ORDER.length + 1; // no ticket, or no status: after the known ones
  const l = label.toLowerCase();
  const i = STATUS_ORDER.findIndex((s) => l.includes(s));
  return i === -1 ? STATUS_ORDER.length : i;
}

const byName = (a: RailRow, b: RailRow) => a.name.localeCompare(b.name);
const waiting = (r: RailRow) => rowSession(r)?.state === 'waiting';

const COMPARATORS: Record<RailSort, (a: RailRow, b: RailRow) => number> = {
  // The default, and why the rail exists: what needs you, then what is alive.
  attention: (a, b) =>
    Number(waiting(b)) - Number(waiting(a)) || Number(b.active) - Number(a.active) || byName(a, b),
  status: (a, b) => statusRank(rowStatus(a)) - statusRank(rowStatus(b)) || byName(a, b),
  running: (a, b) => Number(rowRunning(b)) - Number(rowRunning(a)) || byName(a, b),
  agent: (a, b) => agentRank(a) - agentRank(b) || byName(a, b),
  // Deliberately stable: nothing about the world reorders it, which is the point.
  name: byName,
};

function agentRank(r: RailRow): number {
  const s = rowSession(r);
  return s ? (AGENT_RANK[s.state] ?? 9) : 10; // no agent at all sorts last
}

function rowRunning(r: RailRow): boolean {
  if (r.kind === 'feature') return liveMembers(r.feature).some((m) => m.running);
  return r.kind === 'mainserver';
}

/** This module already imports `world`; an injection hook would be indirection for nothing. */
function rowStatus(r: RailRow): string | undefined {
  return r.kind === 'feature' ? world.taskStatus[r.feature.name]?.label : undefined;
}

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
export type DockView = 'term' | 'changes' | 'logs' | 'runs' | 'usage';

function savedDock(): DockView {
  // Only Insights is worth restoring: the panel views belong to a session and reset with
  // the selection anyway.
  try {
    return localStorage.getItem(DOCK_KEY) === 'usage' ? 'usage' : 'term';
  } catch {
    return 'term';
  }
}

/** A chosen sort persists: it is a working preference, not a per-visit whim. */
function savedRailSort(): RailSort {
  try {
    const v = localStorage.getItem(SORT_KEY) as RailSort | null;
    return v && RAIL_SORTS.some((s) => s.id === v) ? v : 'attention';
  } catch {
    return 'attention';
  }
}

/**
 * The chosen root folder, or '' for all of them.
 *
 * Persisted, and NOT validated against the config here: `world.baseDirs` arrives with the
 * first topology frame, which has not landed when this runs. A root that no longer exists
 * simply matches nothing until the switcher re-renders, and the switcher offers "All
 * roots" as its first entry, so the way out is always on screen.
 */
function savedRoot(): string {
  try {
    return localStorage.getItem(ROOT_KEY) || '';
  } catch {
    return '';
  }
}

function savedRailWidth(): number {
  try {
    const n = Number(localStorage.getItem(RAIL_KEY));
    return Number.isFinite(n) && n >= RAIL_MIN && n <= RAIL_MAX ? n : RAIL_DEFAULT;
  } catch {
    return RAIL_DEFAULT;
  }
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
  return list
    .slice()
    .sort(
      (a, b) =>
        Number(featureActive(b)) - Number(featureActive(a)) || String(a.name).localeCompare(String(b.name)),
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
  /** What was selected before Insights hid it, so the toggle can put it back. */
  #beforeInsights: Selection = null;
  /**
   * Where each selection was last left: which dock tab, which terminal tab.
   *
   * Plain fields, not `$state` — nothing renders from this map directly; it is only ever
   * read to seed `dockView`/`activeTabId`, which are reactive themselves. Making it
   * reactive would buy a proxy over a map that grows one entry per thing you have looked
   * at and is read exactly once per switch.
   */
  #dockMemory = new Map<string, { view: DockView; tab: string }>();
  /** Rail repo filter — '' means all repos. */
  repoFilter = $state('');
  /**
   * The root folder the whole app is scoped to — '' means all of them.
   *
   * A SEPARATE AXIS from `repoFilter`, not a coarser version of it. A root is where a
   * body of work lives (`~/Desktop/ab-code` is the job, `~/Desktop/code` is not), and
   * switching it is switching context; the repo filter narrows within whatever is in
   * front of you. They compose — see `#repoInScope`.
   */
  rootFilter = $state(savedRoot());
  /** How the rail is ordered — see RAIL_SORTS. */
  railSort = $state<RailSort>(savedRailSort());
  /** Drift findings the user has waved off — see driftKey(). */
  driftDismissed = $state<Set<string>>(savedDrift());
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
  get selectedId(): string | null {
    return this.selection?.kind === 'session' ? this.selection.id : null;
  }
  /** Selected sessionless feature's name, or null. Read-only — go through selectFeature(). */
  get selectedFeatureName(): string | null {
    return this.selection?.kind === 'feature' ? this.selection.name : null;
  }

  /** The selected session object, or null. Follows the live `sessions` list. */
  selected = $derived(this.selectedId ? world.session(this.selectedId) : null);

  /** The selected sessionless feature, or null. Follows the live `features` list. */
  selectedFeature = $derived(
    this.selectedFeatureName ? world.features.find((f) => f.name === this.selectedFeatureName) || null : null,
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
      ? world.repos
          .flatMap((r) => r.worktrees || [])
          .find((w) => w.path === (this.selection as { path: string }).path) || null
      : null,
  );

  /**
   * The repos the chosen root admits, or null for "no root chosen, so all of them".
   *
   * A repo's root is read off its MAIN checkout's `baseDir`, which the server already
   * computed (state.ts:baseDirOf) — the client does not re-derive it by comparing path
   * prefixes, which is how the two would come to disagree about a nested baseDir.
   */
  #rootRepos = $derived.by((): Set<string> | null => {
    if (!this.rootFilter) return null;
    const out = new Set<string>();
    for (const r of world.repos) {
      const main = (r.worktrees || []).find((w) => w.isMain);
      if (main && main.baseDir === this.rootFilter) out.add(r.name);
    }
    return out;
  });

  /**
   * ONE membership test for both filters.
   *
   * The two axes were about to be four copies of `!this.filter || x === this.filter`,
   * spread across features, unpromoted sessions, main servers and the repo dropdown —
   * and a fifth list added later would have got one of them and not the other. Composed
   * here instead, so every list asks the same question.
   */
  #repoInScope = (repo: string): boolean =>
    (!this.repoFilter || repo === this.repoFilter) && (!this.#rootRepos || this.#rootRepos.has(repo));

  #featureMatches = (f: Feature): boolean =>
    // Nothing filtering means everything shows — including a manual group whose members
    // have all gone missing, which has no repo to match on and must not vanish silently
    // just because the test moved from "or" to "some".
    (!this.repoFilter && !this.#rootRepos) ||
    // A MissingMember is a dangling config reference with no repo, so it can never
    // match a filter — guard on the discriminant rather than casting it away.
    (f.members || []).some(
      (m) => Boolean(m) && !('missing' in m && m.missing) && this.#repoInScope((m as Worktree).repo),
    );

  /** Features after the repo filter, in rail order. Whole features, never split. */
  visibleFeatures = $derived(sortFeatures(world.features.filter(this.#featureMatches)));

  /** Features with at least one dev server up. */
  serverFeatures = $derived(this.visibleFeatures.filter((f) => liveMembers(f).some((m) => m.running)));

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
      .filter((s) => !s.worktreePath && this.#repoInScope(s.repoName))
      .slice()
      .sort(
        (a, b) =>
          Number(a.state === 'stopped') - Number(b.state === 'stopped') ||
          String(a.title || '').localeCompare(String(b.title || '')),
      ),
  );

  /**
   * Dev servers running from a repo's MAIN checkout. Not a worktree, therefore not a
   * feature, therefore in no other list — without this they are a mystery port.
   */
  visibleMainServers = $derived(
    (() => {
      const web = new Set(world.webRepos || []);
      return world.repos
        .flatMap((r) => r.worktrees || [])
        .filter((w) => w.isMain && web.has(w.repo) && w.running && (w.ports || []).length)
        .filter((w) => this.#repoInScope(w.repo));
    })(),
  );

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
  railRows = $derived<RailRow[]>(
    (() => {
      const rows: RailRow[] = [
        ...this.unpromotedSessions.map(
          (s): RailRow => ({
            kind: 'session',
            key: selectionKey({ kind: 'session', id: s.id }),
            name: s.title,
            session: s,
            active: s.state !== 'stopped',
          }),
        ),
        ...this.visibleMainServers.map(
          (w): RailRow => ({
            kind: 'mainserver',
            key: selectionKey({ kind: 'mainserver', path: w.path }),
            name: w.repo,
            worktree: w,
            active: true,
          }),
        ),
        ...this.visibleFeatures.map(
          (f): RailRow => ({
            kind: 'feature',
            key: selectionKey({ kind: 'feature', name: f.name }),
            name: f.name,
            feature: f,
            active: featureActive(f),
          }),
        ),
      ];
      /*
       * Waiting first, then active, then alphabetical.
       *
       * `active` alone left a waiting agent sitting alphabetically among a dozen equally
       * active idle ones — so the single state worth interrupting you for was no easier
       * to find than anything else. Waiting now reliably occupies row one, which is also
       * what makes the ⌥ digit on the card worth reading.
       */
      rows.sort(COMPARATORS[this.railSort] || COMPARATORS.attention);

      /*
       * REVIEWS ALWAYS COME LAST, as their own group.
       *
       * Not a sort option, deliberately. Making the grouping one of five sorts means the
       * arrangement is undone by choosing any of the other four — including `attention`,
       * the default — and the arrangement is the whole point: your work and other people's
       * are different kinds of thing and the rail should not interleave them.
       *
       * The sort still does its one job. It orders the rows above; reviews carry their own
       * order (drafts last, newest first) from the server, because "attention" and "task
       * status" mean nothing for a merge request nobody here started.
       */
      return [...rows, ...this.reviewRows];
    })(),
  );

  /** Reviews as rail rows, filtered by the same scope every other list uses. */
  reviewRows = $derived<RailRow[]>(
    world.reviews
      .filter((r) => this.#repoInScope(r.repo))
      .map((r): RailRow => ({
        kind: 'review',
        key: selectionKey({ kind: 'review', id: `${r.repo}!${r.number}` }),
        name: r.title,
        review: r,
        // Never "active": that word means a live agent or a running server, and a review
        // has neither. Sorting it as active would put somebody else's MR above your own
        // waiting agent.
        active: false,
      })),
  );

  /** Index of the first review row, or -1 when none — where the second divider goes. */
  reviewsAt = $derived(
    this.reviewRows.length ? this.railRows.length - this.reviewRows.length : -1,
  );

  /** The selected review, or null. */
  selectedReview = $derived(
    this.selection?.kind === 'review'
      ? world.reviews.find(
          (r) => `${r.repo}!${r.number}` === (this.selection as { id: string }).id,
        ) || null
      : null,
  );

  selectReview(item: ReviewItem): void {
    this.#pick({ kind: 'review', id: `${item.repo}!${item.number}` });
  }

  /**
   * Index of the first quiet row, or -1 when there is no meaningful boundary.
   *
   * Only under `attention`, which is the sort that groups active above quiet — under any
   * other the rows are not in that order, so a line labelled "idle · N" would fall in an
   * arbitrary place and claim something untrue about everything below it.
   */
  dividerAt = $derived.by(() => {
    if (this.railSort !== 'attention') return -1;
    // Work rows only: the reviews below have their own divider, and `active` is false for
    // every one of them, so searching the whole list would put the "idle" line at the top
    // of the review group whenever no work row is quiet.
    const work = this.railRows.length - this.reviewRows.length;
    const rows = this.railRows.slice(0, work);
    if (!rows.some((r) => r.active)) return -1;
    const i = rows.findIndex((r) => !r.active);
    return i === -1 ? -1 : i;
  });

  /**
   * What ⌘1–9 picks, in the order the rail actually draws it.
   *
   * This used to be agents-then-features while the rail drew servers-running, main
   * servers, agents, then features — so with one running feature, ⌘1 hit the fourth
   * card on screen. A shortcut that selects something other than what you counted is
   * worse than no shortcut. It is built from the same sections the rail renders, with
   * the servers-running repeat de-duplicated so a feature never occupies two numbers.
   *
   * That still leaves the number MOVING: `active` is the sort key and it flips whenever a
   * dev server starts or a session is deactivated, so starting one stack renumbers the
   * others and ⌥3 becomes a lottery. The cure is not a stabler sort — that would break
   * the invariant this comment defends — it is `railDigits` below, which puts the number
   * on the card so you read it instead of counting. Then a reordering rail is honest
   * rather than misleading, because the label moves with the row.
   */
  railOrder = $derived<RailEntry[]>(
    this.railRows
      .filter((r) => r.kind !== 'mainserver') // nothing to select: it owns no session
      .map((r) => ({
        kind: r.kind === 'session' ? ('session' as const) : ('feature' as const),
        // A review owns no session either, but it IS selectable, so it keeps its place in
        // the ⌥-digit order — a hole here would shift every digit below it.
        id: r.kind === 'session' ? r.session.id : r.kind === 'feature' ? (r.feature.session?.id ?? null) : null,
        name: r.name,
      })),
  );

  /**
   * Row key → the ⌥ digit that selects it, for the first nine selectable rows.
   *
   * Built from the SAME filter as railOrder, so the label and the binding cannot say
   * different things — deriving them separately is how ⌘1 came to hit the fourth card.
   */
  railDigits = $derived(
    new Map<string, number>(
      this.railRows
        .filter((r) => r.kind !== 'mainserver')
        .slice(0, 9)
        .map((r, i): [string, number] => [r.key, i + 1]),
    ),
  );

  /**
   * Repo names offered by the filter: every member repo, plus unpromoted sessions' repos.
   *
   * Scoped by the ROOT but not by itself: offering repos from a root you have switched
   * away from would let you pick one and empty the rail, and the only way back would be
   * to notice that the wrong root is selected.
   */
  repoNames = $derived(
    [
      ...new Set([
        ...world.features.flatMap((f) => liveMembers(f).map((m) => m.repo)),
        ...world.sessions.map((s) => s.repoName),
      ]),
    ]
      .filter((n) => n && (!this.#rootRepos || this.#rootRepos.has(n)))
      .sort(),
  );

  /**
   * The root folders on offer, newest-first in config order, labelled by basename.
   *
   * Only the ones that actually hold a repo: a baseDir pointing somewhere empty (a typo,
   * an unmounted volume — both of which settings.ts saves anyway and warns about) would
   * otherwise appear as a destination that silently shows nothing.
   */
  roots = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const r of world.repos) {
      const main = (r.worktrees || []).find((w) => w.isMain);
      const dir = main?.baseDir || '';
      if (dir) counts.set(dir, (counts.get(dir) || 0) + 1);
    }
    return (world.baseDirs || [])
      .filter((d) => counts.has(d))
      .map((d) => ({
        path: d,
        label: d.replace(/\/+$/, '').split('/').pop() || d,
        repos: counts.get(d) || 0,
      }));
  });

  /** Total repos across every root — what "All roots" is worth. */
  rootTotal = $derived(this.roots.reduce((n, r) => n + r.repos, 0));

  setRoot(path: string): void {
    this.rootFilter = path;
    // The repo filter belongs to the root you were in. Carrying it across means landing
    // on an empty rail filtered by a repo the new root does not contain.
    this.repoFilter = '';
    try {
      localStorage.setItem(ROOT_KEY, path);
    } catch {
      /* private browsing: the choice simply does not persist */
    }
  }

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
    try {
      localStorage.setItem(DOCK_KEY, v === 'usage' ? 'usage' : 'term');
    } catch {
      /* private mode */
    }
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
    /*
     * HIDDEN, not discarded. Clearing is still right while Insights is up — the reason
     * above holds — but this used to be the end of the selection: ⌘\ to glance at usage
     * and ⌘\ back put you on "No session selected", so a two-keystroke look cost you
     * your place in a twelve-row rail. For a toggle-shaped shortcut that is the single
     * most expensive lost-place event in the app.
     */
    if (this.selection) this.#beforeInsights = this.selection;
    this.selection = null;
    this.setDockView('usage');
  }

  toggleUsage(): void {
    if (this.dockView === 'usage') {
      this.setDockView('term');
      // Put back what opening Insights hid, so the toggle is genuinely a toggle.
      if (!this.selection && this.#beforeInsights) this.selection = this.#beforeInsights;
      this.#beforeInsights = null;
      return;
    }
    // Seed the drill-down with whatever is open, so opening Insights while looking at a
    // session lands on that session's breakdown rather than nowhere.
    this.openInsights(this.selectedId);
  }

  /** Is this finding still worth showing? */
  driftVisible(d: { branch: string; features: string[] }): boolean {
    return !this.driftDismissed.has(driftKey(d));
  }

  /**
   * Wave a drift finding off. Reassigned rather than mutated: a `Set` is not deeply
   * reactive, so `.add()` on the same instance would persist and change nothing on screen.
   */
  dismissDrift(d: { branch: string; features: string[] }): void {
    this.driftDismissed = new Set([...this.driftDismissed, driftKey(d)]);
    try {
      localStorage.setItem(DRIFT_KEY, JSON.stringify([...this.driftDismissed]));
    } catch {
      /* private mode */
    }
  }

  setRailSort(v: RailSort): void {
    this.railSort = v;
    try {
      localStorage.setItem(SORT_KEY, v);
    } catch {
      /* private mode */
    }
  }

  setRailWidth(px: number): void {
    this.railWidth = Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.round(px)));
    try {
      localStorage.setItem(RAIL_KEY, String(this.railWidth));
    } catch {
      /* private mode */
    }
  }

  /**
   * Replace the selection, restoring whatever dock state that thing was last left in.
   *
   * This used to reset to the terminal on every pick. So: read a diff on feature A, look
   * at B for a second, come back — you are on the terminal, on whatever tab tmux happens
   * to have selected, and you re-navigate. Times a dozen features, that is most of what
   * "switching is expensive" actually consists of.
   *
   * Keyed the same way the rail keys its rows, and deliberately NOT persisted: it
   * describes where you were a moment ago, and restoring it across a reload would mean
   * opening the app into a stale view of a session you have not looked at in a week.
   */
  #pick(next: Selection): void {
    const from = selectionKey(this.selection);
    if (from) this.#dockMemory.set(from, { view: this.dockView, tab: this.activeTabId });
    this.selection = next;
    const back = this.#dockMemory.get(selectionKey(next));
    this.dockView = back?.view ?? 'term';
    this.activeTabId = back?.tab ?? '';
  }

  select(id: string): void {
    if (this.selection?.kind === 'session' && this.selection.id === id) return;
    this.#pick({ kind: 'session', id });
  }

  /**
   * Apply a selection that arrived from outside the app — a deep link.
   *
   * Unlike `selectFeature`, this does not need the Feature object: a link can name
   * something the world has not streamed yet, and `selectionPending` already covers
   * the gap between selecting and arriving. Re-applying what is already selected is a
   * no-op, which is what keeps the URL-writing effect from fighting the hash listener.
   */
  applySelection(s: Selection): void {
    if (selectionKey(s) === selectionKey(this.selection)) return;
    this.#pick(s);
  }

  /** The current selection as a rail key — what a deep link is built from. */
  get key(): string {
    return selectionKey(this.selection);
  }

  /**
   * Pick a feature. One with an agent behaves exactly as picking that session did; one
   * without has no terminal to show, so the dock renders the feature pane instead.
   */
  selectFeature(f: Feature | null | undefined): void {
    if (f?.session?.id) {
      this.select(f.session.id);
      return;
    }
    this.#pick(f ? { kind: 'feature', name: f.name } : null);
  }

  /** Pick a dev server running from a repo's main checkout. */
  selectMainServer(path: string): void {
    if (this.selection?.kind === 'mainserver' && this.selection.path === path) return;
    this.#pick({ kind: 'mainserver', path });
  }

  /** Nothing selected. */
  clearSelection(): void {
    this.selection = null;
  }

  /**
   * Select the next session that is waiting on you, cycling past the one you are on.
   *
   * The waiting count used to be a badge on the Insights button, so the one state worth
   * interrupting someone for routed them AWAY from the thing that wanted them — and,
   * before the fix in openInsights, cost them their selection on the way. A count is a
   * question ("who needs me?"); this is the answer.
   */
  goToNextWaiting(): boolean {
    // rowSession, not `r.kind === 'session'`: a PROMOTED session is a `feature` row with
    // the agent embedded, and promoting is the normal path — so the old filter matched
    // almost nothing and the button did nothing for a whole fleet.
    const waiting = this.railRows.filter((r) => rowSession(r)?.state === 'waiting');
    if (!waiting.length) return false;
    const here = waiting.findIndex((r) => r.key === selectionKey(this.selection));
    const next = waiting[(here + 1) % waiting.length];
    // Both shapes, again: selecting the feature is what puts a promoted agent on screen.
    if (next.kind === 'session') this.goToSession(next.session.id);
    else if (next.kind === 'feature') this.selectFeature(next.feature);
    return true;
  }

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
