import { beforeEach, describe, expect, it } from 'vitest';
import { world } from './world.svelte.js';
import { featureActive, liveMembers, sortFeatures, ui } from './ui.svelte.js';
import type { Feature, Session } from '../../../../server/types';

/*
 * The rail's model: what is drawn, in what order, and what ⌘1–9 selects.
 *
 * Every one of these pins a rule that was wrong at some point today. The rail used to
 * draw a feature twice; ⌘1–9 was ordered differently from the list it indexes; the repo
 * filter split BE+FE features in half; "active" was computed in two places that could
 * disagree. They are cheap to assert and expensive to notice by eye.
 *
 * The store reads `world`, so each test drives the two SSE halves directly — the same
 * shape the daemon sends.
 */

const embedded = (id: string, state: string) => ({ id, state, activity: '', muxName: `m-${id}` });

const member = (repo: string, over: Record<string, unknown> = {}) => ({
  repo,
  wtname: 'wt',
  path: `/${repo}/wt`,
  branch: 'feature/x',
  running: false,
  canStart: true,
  ports: [],
  isMain: false,
  session: null,
  ...over,
});

const feature = (name: string, members: unknown[], session: unknown = null): Feature =>
  ({ name, auto: true, members, session }) as unknown as Feature;

const session = (id: string, over: Record<string, unknown> = {}): Session =>
  ({
    id,
    title: id,
    state: 'idle',
    activity: '',
    muxName: `m-${id}`,
    repoName: 'accept-blue',
    worktreePath: null,
    ...over,
  }) as unknown as Session;

/** Drive the store the way the stream does: two halves, kept whole. */
function give({
  features = [] as Feature[],
  sessions = [] as Session[],
  repos = [] as unknown[],
  webRepos = [] as string[],
  taskStatus = undefined as Record<string, { label: string; done: boolean }> | undefined,
  baseDirs = [] as string[],
}) {
  world.topology = { features, groups: [], repos, webRepos, baseDirs } as never;
  world.sessionHalf = { sessions, servers: {} } as never;
  // The ci half carries task status — same cadence, same kind of thing (see CiPayload).
  world.ciHalf = { ci: {}, taskStatus } as never;
}

beforeEach(() => {
  give({});
  ui.repoFilter = '';
  ui.rootFilter = '';
  ui.railSort = 'attention'; // the default, so one test's choice does not leak into the next
  ui.clearSelection();
});

describe('featureActive', () => {
  it('is true for a live agent OR a running server, false for neither', () => {
    expect(featureActive(feature('a', [member('r')]))).toBe(false);
    expect(featureActive(feature('b', [member('r', { running: true })]))).toBe(true);
    expect(featureActive(feature('c', [member('r', { session: embedded('s', 'idle') })]))).toBe(true);
  });

  it('does not count a stopped agent as active', () => {
    expect(featureActive(feature('d', [member('r', { session: embedded('s', 'stopped') })]))).toBe(false);
  });

  it('ignores a missing member rather than reading fields off it', () => {
    expect(featureActive(feature('e', [{ missing: true, ref: 'gone' }]))).toBe(false);
  });
});

describe('liveMembers', () => {
  it('drops missing members, which have no repo to read', () => {
    const f = feature('f', [member('accept-blue'), { missing: true, ref: 'x' }]);
    expect(liveMembers(f).map((m) => m.repo)).toEqual(['accept-blue']);
  });
});

describe('sortFeatures', () => {
  it('puts active first, then alphabetical — so a feature does not jump when its stack starts', () => {
    const out = sortFeatures([
      feature('zed', [member('r')]),
      feature('alpha', [member('r')]),
      feature('beta', [member('r', { running: true })]),
    ]);
    expect(out.map((f) => f.name)).toEqual(['beta', 'alpha', 'zed']);
  });
});

describe('the rail', () => {
  it('draws one row per thing — a running feature is not repeated', () => {
    give({ features: [feature('one', [member('accept-blue', { running: true })])] });
    expect(ui.railRows.map((r) => r.key)).toEqual(['f:one']);
  });

  it('holds agents, main-checkout servers and features in ONE list', () => {
    give({
      features: [feature('feat', [member('accept-blue')])],
      sessions: [session('s1')],
      repos: [
        {
          name: 'ab-iso-fe',
          worktrees: [member('ab-iso-fe', { isMain: true, running: true, ports: [5271], path: '/main' })],
        },
      ],
      webRepos: ['ab-iso-fe'],
    });
    expect(ui.railRows.map((r) => r.kind).sort()).toEqual(['feature', 'mainserver', 'session']);
  });

  it('sorts active rows above quiet ones and marks the boundary', () => {
    give({
      features: [
        feature('quiet', [member('accept-blue')]),
        feature('busy', [member('accept-blue', { running: true })]),
      ],
    });
    expect(ui.railRows.map((r) => r.name)).toEqual(['busy', 'quiet']);
    expect(ui.dividerAt).toBe(1);
  });

  it('reports no divider when everything is active', () => {
    give({ features: [feature('busy', [member('accept-blue', { running: true })])] });
    expect(ui.dividerAt).toBe(-1);
  });

  it('keeps a waiting agent above the quiet rows, not filed with them', () => {
    // The reason the rail has no "not running" bucket: a waiting agent is the one row
    // that wants the user, and a bucket keyed on "running" would bury it.
    give({
      features: [
        feature('stale', [member('accept-blue')]),
        feature(
          'needsyou',
          [member('accept-blue', { session: embedded('s9', 'waiting') })],
          embedded('s9', 'waiting'),
        ),
      ],
    });
    expect(ui.railRows[0].name).toBe('needsyou');
  });
});

describe('the repo filter', () => {
  const beFe = () => feature('shared', [member('accept-blue'), member('merchant-v3')]);

  it('matches on ANY member repo and keeps the feature whole', () => {
    give({ features: [beFe()] });
    ui.repoFilter = 'merchant-v3';
    expect(ui.visibleFeatures).toHaveLength(1);
    // Splitting it would defeat the shared-worktree-name convention that groups it.
    expect(liveMembers(ui.visibleFeatures[0]).map((m) => m.repo)).toEqual(['accept-blue', 'merchant-v3']);
  });

  it('excludes a feature that touches no matching repo', () => {
    give({ features: [beFe(), feature('other', [member('ab-su')])] });
    ui.repoFilter = 'merchant-v3';
    expect(ui.visibleFeatures.map((f) => f.name)).toEqual(['shared']);
  });
});

describe('railOrder — what ⌘1–9 picks', () => {
  it('matches the order the rail draws, so ⌘N is the Nth card', () => {
    give({
      features: [
        feature('quiet', [member('accept-blue')]),
        feature('busy', [member('accept-blue', { running: true })]),
      ],
      sessions: [session('s1', { title: 'agent' })],
    });
    const drawn = ui.railRows.filter((r) => r.kind !== 'mainserver').map((r) => r.name);
    expect(ui.railOrder.map((e) => e.name)).toEqual(drawn);
  });

  it('carries a null id for a feature with no agent — there is no session to jump to', () => {
    give({ features: [feature('bare', [member('accept-blue')])] });
    expect(ui.railOrder[0]).toMatchObject({ kind: 'feature', id: null, name: 'bare' });
  });
});

describe('selection', () => {
  it('never holds a session and a feature at once', () => {
    give({ features: [feature('f', [member('accept-blue')])], sessions: [session('s1')] });
    ui.selectFeature(ui.visibleFeatures[0]);
    expect(ui.selectedFeatureName).toBe('f');

    ui.select('s1');
    // The invariant the store documents — and which startFeatureSession broke by
    // assigning selectedId directly, leaving the feature pane on screen.
    expect(ui.selectedFeatureName).toBeNull();
    expect(ui.selectedId).toBe('s1');
  });

  it('selecting a feature that HAS an agent selects the agent', () => {
    give({
      features: [
        feature('f', [member('accept-blue', { session: embedded('s1', 'idle') })], embedded('s1', 'idle')),
      ],
      sessions: [session('s1')],
    });
    ui.selectFeature(ui.visibleFeatures[0]);
    expect(ui.selectedId).toBe('s1');
    expect(ui.selectedFeatureName).toBeNull();
  });

  it('reports a pending selection while the frame carrying the session is in flight', () => {
    // Selection happens when the create call returns; the session arrives with the next
    // SSE frame. That window used to render "No session selected".
    give({ sessions: [] });
    ui.select('brand-new');
    expect(ui.selectionPending).toBe(true);

    give({ sessions: [session('brand-new')] });
    expect(ui.selectionPending).toBe(false);
  });
});

describe('switching without losing your place', () => {
  /*
   * The three things that made a context switch expensive. None of them was a bug in the
   * sense of throwing — each just quietly discarded state the user had established, and
   * the cost only shows up as "coming back is annoying", which is exactly the kind of
   * thing nobody files.
   */

  it('⌘\\ into Insights and back RESTORES the selection', () => {
    give({ features: [], sessions: [session('s1')] });
    ui.select('s1');

    ui.toggleUsage();
    expect(ui.dockView).toBe('usage');
    // Still cleared while Insights is up — the ActionBar must not offer Stop stack for
    // something that is not on screen.
    expect(ui.selectedId).toBeNull();

    ui.toggleUsage();
    expect(ui.dockView).toBe('term');
    expect(ui.selectedId).toBe('s1');
  });

  it('remembers which dock tab each selection was left on', () => {
    give({
      features: [feature('f', [member('accept-blue')])],
      sessions: [session('s1'), session('s2')],
    });
    ui.select('s1');
    ui.setDockView('usage'); // stand-in for Changes/Runs: any non-terminal view
    expect(ui.dockView).toBe('usage');

    ui.select('s2');
    expect(ui.dockView).toBe('term');

    // Back to s1 — you were reading something there, and that is where you land.
    ui.select('s1');
    expect(ui.dockView).toBe('usage');
  });

  it('a selection never seen before opens on its terminal', () => {
    give({ features: [], sessions: [session('s1'), session('s2')] });
    ui.select('s1');
    ui.setDockView('usage');
    ui.select('s2');
    expect(ui.dockView).toBe('term');
  });

  it('sorts a waiting agent to the top, above merely-active ones', () => {
    give({
      features: [],
      sessions: [
        session('a', { title: 'aaa', state: 'idle' }),
        session('z', { title: 'zzz', state: 'waiting' }),
      ],
    });
    // Alphabetically 'zzz' is last and both are active; waiting is what you need to find.
    expect(ui.railRows[0].name).toBe('zzz');
  });

  it('finds a waiting agent on a PROMOTED feature — the normal case', () => {
    /*
     * The bug that made the button dead. A rail row is one of three shapes, and a promoted
     * session appears as `kind:'feature'` with the agent EMBEDDED — while an unpromoted
     * one is `kind:'session'` carrying it directly. Both the waiting sort and the jump
     * filtered on `kind === 'session'`, so they covered only unpromoted sessions.
     *
     * Promoting is the normal path: a fleet of ten promoted features had a badge counting
     * them and a button that could not find a single one.
     */
    give({
      features: [
        feature('quiet', [member('accept-blue')], embedded('s1', 'idle')),
        feature('needs-you', [member('merchant-v3')], embedded('s2', 'waiting')),
      ],
      // Promoted, so they do NOT also appear as their own unpromoted rows — which is what
      // makes them `feature` rows and is the whole point of this test.
      sessions: [
        session('s1', { state: 'idle', worktreePath: '/wt/quiet' }),
        session('s2', { state: 'waiting', worktreePath: '/wt/needs-you' }),
      ],
    });

    // It sorts to the top…
    expect(ui.railRows[0].name).toBe('needs-you');
    // …and the jump actually selects it.
    expect(ui.goToNextWaiting()).toBe(true);
    expect(ui.selectedFeatureName === 'needs-you' || ui.selectedId === 's2').toBe(true);
  });

  it('goToNextWaiting cycles, and says so when nothing is waiting', () => {
    give({
      features: [],
      sessions: [
        session('w1', { title: 'w1', state: 'waiting' }),
        session('w2', { title: 'w2', state: 'waiting' }),
      ],
    });
    expect(ui.goToNextWaiting()).toBe(true);
    const first = ui.selectedId;
    expect(ui.goToNextWaiting()).toBe(true);
    expect(ui.selectedId).not.toBe(first);
    // …and wraps rather than stopping at the end.
    expect(ui.goToNextWaiting()).toBe(true);
    expect(ui.selectedId).toBe(first);
  });

  it('the ⌥ digit a card shows is the one that selects it', () => {
    give({
      features: [feature('feat', [member('accept-blue')])],
      sessions: [session('s1', { title: 'sess' })],
    });
    // Whatever the order works out to, the label and the binding are built from one
    // filter — deriving them separately is how ⌘1 came to hit the fourth card.
    for (const [i, row] of ui.railOrder.entries()) {
      const key = row.kind === 'session' ? `s:${row.id}` : `f:${row.name}`;
      if (i < 9) expect(ui.railDigits.get(key)).toBe(i + 1);
    }
  });
});

describe('rail sorting', () => {
  /*
   * The default sort is what the app is designed around; the others exist because what
   * you are looking FOR changes with what you are doing. Reviewing a board is a different
   * question from finding the agent that stopped.
   */
  const board = () =>
    give({
      features: [
        feature('zeta', [member('accept-blue', { running: true })], embedded('s1', 'idle')),
        feature('alpha', [member('merchant-v3')], embedded('s2', 'waiting')),
        feature('mid', [member('ab-su')], embedded('s3', 'working')),
      ],
      sessions: [
        session('s1', { state: 'idle', worktreePath: '/wt/zeta' }),
        session('s2', { state: 'waiting', worktreePath: '/wt/alpha' }),
        session('s3', { state: 'working', worktreePath: '/wt/mid' }),
      ],
    });

  it('attention puts what needs you first, then what is alive', () => {
    board();
    ui.setRailSort('attention');
    expect(ui.railRows[0].name).toBe('alpha'); // waiting
  });

  it('name is stable — nothing about the world reorders it', () => {
    board();
    ui.setRailSort('name');
    expect(ui.railRows.map((r) => r.name)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('running puts features with dev servers up first', () => {
    board();
    ui.setRailSort('running');
    expect(ui.railRows[0].name).toBe('zeta');
  });

  it('agent orders by the state you care about, not alphabetically', () => {
    // The reason it is a rank and not a string compare: alphabetically `idle` sorts above
    // `waiting`, which is the exact inversion the ordering exists to prevent.
    board();
    ui.setRailSort('agent');
    expect(ui.railRows.map((r) => r.name)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('the idle divider is drawn ONLY under attention', () => {
    // Any other sort does not group active above quiet, so a line labelled "idle · N"
    // would land somewhere arbitrary and claim something untrue about everything below it.
    board();
    ui.setRailSort('attention');
    expect(ui.dividerAt).toBeGreaterThanOrEqual(-1);
    ui.setRailSort('name');
    expect(ui.dividerAt).toBe(-1);
  });

  it('an unrecognised task status sorts AFTER the ones we can place', () => {
    // Trackers name columns freely. Something we cannot rank must not jumble in among
    // the ones we can — it goes to the end, where "we do not know" belongs.
    give({
      features: [feature('known', [member('accept-blue')]), feature('odd', [member('ab-su')])],
      sessions: [],
      taskStatus: { known: { label: 'In Progress', done: false }, odd: { label: 'Wibble', done: false } },
    });
    ui.setRailSort('status');
    expect(ui.railRows.map((r) => r.name)).toEqual(['known', 'odd']);
  });
});

/*
 * THE ROOT SWITCHER.
 *
 * A root is where a body of work lives — `~/Desktop/ab-code` is the job, `~/Desktop/code`
 * is not — so switching roots is switching context, and it scopes the whole app rather
 * than filtering one list. It is a SEPARATE AXIS from the repo filter, and the two
 * compose: both go through one membership test, because four hand-rolled copies of
 * `!filter || x === filter` is how a fifth list ends up honouring one and not the other.
 *
 * A repo's root is read off its MAIN checkout's `baseDir`, which the server computed.
 */
const WORK = '/Users/x/Desktop/ab-code';
const PERSONAL = '/Users/x/Desktop/code';

/** A repo whose main checkout declares which root it lives under. */
const repoIn = (name: string, baseDir: string) => ({
  name,
  repo: name,
  path: `${baseDir}/${name}`,
  worktrees: [{ repo: name, wtname: name, path: `${baseDir}/${name}`, isMain: true, baseDir, running: false, ports: [] }],
});

function twoRoots() {
  give({
    baseDirs: [WORK, PERSONAL],
    repos: [repoIn('accept-blue', WORK), repoIn('merchant-v3', WORK), repoIn('studio', PERSONAL)],
    features: [
      feature('mfa', [member('accept-blue'), member('merchant-v3')]),
      feature('sticky', [member('studio')]),
    ],
    sessions: [session('u1', { repoName: 'studio' })],
  });
}

describe('root switcher', () => {
  it('offers each root that holds a repo, labelled by basename and counted', () => {
    twoRoots();
    expect(ui.roots).toEqual([
      { path: WORK, label: 'ab-code', repos: 2 },
      { path: PERSONAL, label: 'code', repos: 1 },
    ]);
    expect(ui.rootTotal).toBe(3);
  });

  it('drops a configured root that holds nothing', () => {
    /*
     * settings.ts saves a baseDir that does not exist (it may be an unmounted volume) and
     * warns instead of refusing. Offering it here would be a destination that silently
     * shows an empty rail — which looks exactly like Studio being broken.
     */
    give({ baseDirs: [WORK, '/nowhere'], repos: [repoIn('accept-blue', WORK)] });
    expect(ui.roots.map((r) => r.path)).toEqual([WORK]);
  });

  it('scopes features, unpromoted sessions and the repo dropdown together', () => {
    twoRoots();
    ui.setRoot(WORK);
    expect(ui.visibleFeatures.map((f) => f.name)).toEqual(['mfa']);
    // The unpromoted session lives in the personal root, so it goes too — the rail is one
    // list, and a root that hides half of it is worse than no switch at all.
    expect(ui.unpromotedSessions.map((s) => s.id)).toEqual([]);
    expect(ui.repoNames).toEqual(['accept-blue', 'merchant-v3']);
  });

  it('composes with the repo filter rather than overriding it', () => {
    twoRoots();
    ui.setRoot(WORK);
    ui.repoFilter = 'merchant-v3';
    expect(ui.visibleFeatures.map((f) => f.name)).toEqual(['mfa']);
    ui.repoFilter = 'studio'; // in the other root: the root wins, and nothing shows
    expect(ui.visibleFeatures).toEqual([]);
  });

  it('clears the repo filter when the root changes', () => {
    /*
     * The repo filter belongs to the root you were in. Carrying `merchant-v3` into the
     * personal root leaves an empty rail filtered by a repo that root does not contain,
     * with the cause two controls away from the symptom.
     */
    twoRoots();
    ui.setRoot(WORK);
    ui.repoFilter = 'merchant-v3';
    ui.setRoot(PERSONAL);
    expect(ui.repoFilter).toBe('');
    expect(ui.visibleFeatures.map((f) => f.name)).toEqual(['sticky']);
  });

  it('shows everything again on All roots', () => {
    twoRoots();
    ui.setRoot(WORK);
    ui.setRoot('');
    expect(ui.visibleFeatures.map((f) => f.name).sort()).toEqual(['mfa', 'sticky']);
    expect(ui.unpromotedSessions.map((s) => s.id)).toEqual(['u1']);
  });

  it('keeps a feature whole when only one of its repos is in the root', () => {
    /*
     * The same rule the repo filter follows: a feature renders WHOLE or not at all.
     * Showing only the matching members would split a BE+FE feature down the middle,
     * which is the grouping the shared-worktree-name convention exists to create.
     */
    give({
      baseDirs: [WORK, PERSONAL],
      repos: [repoIn('accept-blue', WORK), repoIn('studio', PERSONAL)],
      features: [feature('split', [member('accept-blue'), member('studio')])],
    });
    ui.setRoot(WORK);
    const f = ui.visibleFeatures.find((x) => x.name === 'split');
    expect(f).toBeTruthy();
    expect(f?.members).toHaveLength(2);
  });
});
