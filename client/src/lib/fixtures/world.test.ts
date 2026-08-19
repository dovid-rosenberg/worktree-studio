import { describe, expect, it } from 'vitest';
import { feature, install, makeWorld, member, session } from './world.js';

/*
 * The factory's own contract. Thin on purpose — its value is that it is TYPED and
 * complete, which the compiler checks and a test cannot. What is worth pinning is the
 * behaviour every caller relies on: defaults that look like the real wire, and overrides
 * that replace rather than merge-and-surprise.
 */
describe('makeWorld', () => {
  it('defaults to one feature with one startable, stopped member', () => {
    const w = makeWorld();
    expect(w.topology.features).toHaveLength(1);
    const m = w.topology.features[0].members[0] as ReturnType<typeof member>;
    expect(m.running).toBe(false);
    expect(m.canStart).toBe(true);
    expect(m.isMain).toBe(false);
  });

  it('carries a buildId so the skew banner is quiet in fixtures', () => {
    expect(makeWorld().topology.config.buildId).toBeTruthy();
  });

  it('replaces a top-level key rather than merging into it', () => {
    const w = makeWorld({ features: [] });
    expect(w.topology.features).toEqual([]);
  });

  it('overrides reach the nested builders', () => {
    const f = feature({ name: 'custom-reports', members: [member({ repo: 'merchant-v3', running: true })] });
    expect(f.members[0]).toMatchObject({ repo: 'merchant-v3', running: true });
    // The path is derived from the overridden repo, not left pointing at the default.
    expect((f.members[0] as ReturnType<typeof member>).path).toContain('merchant-v3');
  });

  it('install writes exactly the three halves', () => {
    const store = { topology: null as unknown, sessionHalf: null as unknown, ciHalf: null as unknown };
    const w = makeWorld({ sessions: [session()] });
    install(store, w);
    expect(store.topology).toBe(w.topology);
    expect(store.sessionHalf).toBe(w.sessionHalf);
    expect(store.ciHalf).toBe(w.ciHalf);
  });
});
