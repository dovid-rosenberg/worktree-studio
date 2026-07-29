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
  ({ name, auto: true, members, session } as unknown as Feature);

const session = (id: string, over: Record<string, unknown> = {}): Session =>
  ({ id, title: id, state: 'idle', activity: '', muxName: `m-${id}`, repoName: 'accept-blue', worktreePath: null, ...over } as unknown as Session);

/** Drive the store the way the stream does: two halves, kept whole. */
function give({ features = [] as Feature[], sessions = [] as Session[], repos = [] as unknown[], webRepos = [] as string[] }) {
  world.topology = { features, groups: [], repos, webRepos } as never;
  world.sessionHalf = { sessions, servers: {} } as never;
}

beforeEach(() => {
  give({});
  ui.repoFilter = '';
  ui.selectedId = null;
  ui.selectedFeatureName = null;
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
      repos: [{ name: 'ab-iso-fe', worktrees: [member('ab-iso-fe', { isMain: true, running: true, ports: [5271], path: '/main' })] }],
      webRepos: ['ab-iso-fe'],
    });
    expect(ui.railRows.map((r) => r.kind).sort()).toEqual(['agent', 'feature', 'mainserver']);
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
        feature('needsyou', [member('accept-blue', { session: embedded('s9', 'waiting') })], embedded('s9', 'waiting')),
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
      features: [feature('f', [member('accept-blue', { session: embedded('s1', 'idle') })], embedded('s1', 'idle'))],
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
    ui.selectedId = 'brand-new';
    expect(ui.selectionPending).toBe(true);

    give({ sessions: [session('brand-new')] });
    expect(ui.selectionPending).toBe(false);
  });
});
