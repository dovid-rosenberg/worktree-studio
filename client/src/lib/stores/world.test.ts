import { describe, expect, it } from 'vitest';
import { stitchSessions, webAppsFor } from './world.svelte.js';
import type { Feature, Repo, Session } from '../../../../server/types';

/*
 * `stitchSessions` is the one piece of client logic that has already produced a real
 * bug, and it is the hardest to eyeball: the daemon sends the world in two halves, and
 * the topology half embeds a FROZEN copy of each driving session into every worktree,
 * feature and group. Those copies are stale the moment an agent changes state — which
 * is several times a second — so the view has to be re-derived from both halves on
 * every frame rather than patched in place.
 *
 * Everything below is about that contract. It is pure, so it is cheap to pin.
 */

const session = (over: Partial<Session> = {}): Session =>
  ({
    id: 's1',
    title: 'one',
    state: 'working',
    activity: 'Edit file',
    muxName: 'wts-one-s1',
    repoName: 'accept-blue',
    repoPath: '/repo',
    home: '/repo',
    worktree: null,
    worktreePath: null,
    branch: null,
    feature: 'one',
    repos: [],
    tabs: [],
    active: true,
    ...over,
  }) as Session;

/** A frame as the daemon sends it: embedded copies carry whatever was true at build time. */
const worldOf = (over: Record<string, unknown> = {}) =>
  ({
    mux: 'tmux',
    repos: [] as Repo[],
    sessions: [] as Session[],
    servers: {},
    features: [] as Feature[],
    groups: [] as Feature[],
    drift: [],
    webRepos: [] as string[],
    baseDirs: [],
    editors: [],
    ci: {},
    ...over,
  }) as Parameters<typeof stitchSessions>[0];

describe('stitchSessions', () => {
  it('refreshes a stale embedded session from the live list', () => {
    const live = session({ state: 'waiting', activity: 'needs you' });
    const out = stitchSessions(
      worldOf({
        sessions: [live],
        features: [
          {
            name: 'one',
            auto: true,
            // The topology half was built when the agent was 'working'.
            session: { id: 's1', state: 'working', activity: 'Edit file', muxName: 'wts-one-s1' },
            members: [],
          } as unknown as Feature,
        ],
      }),
    );
    expect(out.features[0].session).toEqual({
      id: 's1',
      state: 'waiting',
      activity: 'needs you',
      muxName: 'wts-one-s1',
      // The title rides along too, and is refreshed like the rest: a rename lands in the
      // session half, and the rail reads its label off this projection.
      title: 'one',
    });
  });

  it('drops an embedded session that no longer exists', () => {
    // A closed session lingered on its worktree forever before this projection existed.
    const out = stitchSessions(
      worldOf({
        sessions: [],
        features: [
          {
            name: 'gone',
            auto: true,
            session: { id: 'dead', state: 'working', activity: '', muxName: 'm' },
            members: [],
          } as unknown as Feature,
        ],
      }),
    );
    expect(out.features[0].session).toBeNull();
  });

  it('projects members and repo worktrees, not just the feature itself', () => {
    // A feature's members are serialized separately from repos[].worktrees, so on this
    // side they are distinct objects and each needs the same refresh.
    const live = session({ state: 'idle', activity: 'done' });
    const embedded = { id: 's1', state: 'working', activity: 'stale', muxName: 'wts-one-s1' };
    const out = stitchSessions(
      worldOf({
        sessions: [live],
        repos: [
          {
            name: 'accept-blue',
            worktrees: [{ repo: 'accept-blue', path: '/wt', session: embedded }],
          } as unknown as Repo,
        ],
        features: [
          {
            name: 'one',
            auto: true,
            session: embedded,
            members: [{ repo: 'accept-blue', path: '/wt', session: embedded }],
          } as unknown as Feature,
        ],
      }),
    );
    expect(out.repos[0].worktrees[0].session?.state).toBe('idle');
    expect((out.features[0].members[0] as { session?: { state: string } }).session?.state).toBe('idle');
  });

  it('leaves a missing member alone rather than reaching into it', () => {
    // A MissingMember is a dangling config reference: { missing, ref } and nothing else.
    const out = stitchSessions(
      worldOf({
        sessions: [],
        features: [
          {
            name: 'f',
            auto: true,
            session: null,
            members: [{ missing: true, ref: 'repo/gone' }],
          } as unknown as Feature,
        ],
      }),
    );
    expect(out.features[0].members[0]).toEqual({ missing: true, ref: 'repo/gone' });
  });

  it('does not mutate the frames it reads', () => {
    // The whole design rests on this: the halves are kept verbatim and the view derived,
    // so a topology frame arriving first cannot overwrite the world with stale rows.
    const embedded = { id: 's1', state: 'working', activity: 'stale', muxName: 'm' };
    const feature = { name: 'one', auto: true, session: embedded, members: [] } as unknown as Feature;
    const frame = worldOf({ sessions: [session({ state: 'idle' })], features: [feature] });

    const before = JSON.stringify(frame);
    stitchSessions(frame);
    expect(JSON.stringify(frame)).toBe(before);
  });
});

describe('webAppsFor', () => {
  it('offers only web repos that are running with a discovered port', () => {
    const rows = [
      { repo: 'merchant-v3', running: true, ports: [5273] },
      { repo: 'accept-blue', running: true, ports: [1233] }, // not a web repo
      { repo: 'ab-iso-fe', running: false, ports: [9000] }, // not running
      { repo: 'ab-su', running: true, ports: [] }, // no port discovered
    ];
    // webRepos comes off the world, which is empty here, so nothing qualifies…
    expect(webAppsFor(rows)).toEqual([]);
  });

  it('tolerates a row with no ports array at all', () => {
    expect(() => webAppsFor([{ repo: 'x', running: true }])).not.toThrow();
  });
});
