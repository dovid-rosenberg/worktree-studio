'use strict';
// The SSE contract (server/broadcast.js, docs/api.md): two named event types with
// very different rates, each a full replacement of its half of the state payload.
// What has to hold is not "the frames got smaller" but "a client that applies
// them ends up with exactly what a full rebuild would have given it" — including
// a client that connects late, or reconnects mid-stream.
const { test } = require('node:test');
const assert = require('node:assert');
const { createBroadcast } = require('../server/broadcast');

// A stand-in for the express response: records everything written to it.
function fakeClient() {
  const chunks = [];
  return { chunks, write: (s) => chunks.push(s), frames: () => parse(chunks.join('')) };
}

// Parse an SSE byte stream into [{ event, data }], ignoring `:` comments.
function parse(text) {
  return text.split('\n\n').filter(Boolean).map((block) => {
    const lines = block.split('\n').filter((l) => l && !l.startsWith(':'));
    if (!lines.length) return null;
    const event = (lines.find((l) => l.startsWith('event: ')) || '').slice(7);
    const data = (lines.find((l) => l.startsWith('data: ')) || '').slice(6);
    return { event, data: JSON.parse(data) };
  }).filter(Boolean);
}

// A mutable world producing the same two halves state.js does — including the
// trimmed session copy topology() embeds in every worktree row and feature, built
// from the sessions as they are AT BUILD TIME. That embedding is the reason a
// client has to re-project: between two topology frames those copies age.
function world() {
  const w = {
    worktrees: [{ wtname: 'feat-a', path: '/w/a', sessionId: 's_1' }],
    sessions: [{ id: 's_1', state: 'idle', activity: 'starting…', muxName: 'm1', title: 'A' }],
    servers: { s_1: { repos: [{ repo: 'api', worktreePath: '/w/a', running: false, ports: [] }] } },
  };
  const trim = (id) => {
    const s = w.sessions.find((x) => x.id === id);
    return s ? { id: s.id, state: s.state, activity: s.activity, muxName: s.muxName } : null;
  };
  const topology = () => {
    const wts = w.worktrees.map((x) => ({ wtname: x.wtname, path: x.path, session: trim(x.sessionId) }));
    const features = wts.map((x) => ({ name: x.wtname, members: [x], session: x.session }));
    return { mux: 'tmux', runningTotal: 0, repos: [{ name: 'api', worktrees: wts }], features, groups: [] };
  };
  const sessionState = () => ({ sessions: w.sessions, servers: w.servers });
  // What GET /state returns right now — the yardstick every client must match.
  const buildState = () => JSON.parse(JSON.stringify({ ...topology(), ...sessionState() }));
  return { w, topology, sessionState, buildState };
}

// The reference client: what public/app.js does with a frame — keep each half
// verbatim, derive the state from the latest of both, and re-project the live
// sessions onto the trimmed copies the topology embeds (stitchSessions()).
function refClient() {
  let topo = {}, sess = {}, state = {};
  return {
    get state() { return state; },
    apply(frame) {
      if (frame.event === 'session-state') sess = frame.data; else topo = frame.data;
      const next = { ...topo, ...sess };
      const byId = new Map((next.sessions || []).map((s) => [s.id, s]));
      const fresh = (e) => {
        if (!e) return null;
        const s = byId.get(e.id);
        return s ? { id: s.id, state: s.state, activity: s.activity, muxName: s.muxName } : null;
      };
      const feat = (list) => (list || []).map((f) => ({
        ...f,
        session: fresh(f.session),
        members: (f.members || []).map((m) => (m && !m.missing ? { ...m, session: fresh(m.session) } : m)),
      }));
      state = {
        ...next,
        repos: (next.repos || []).map((r) => ({ ...r, worktrees: (r.worktrees || []).map((w) => ({ ...w, session: fresh(w.session) })) })),
        features: feat(next.features),
        groups: feat(next.groups),
      };
    },
  };
}

test('a subscriber gets a full snapshot — one frame of each half — before it joins the fan-out', () => {
  const { topology, sessionState } = world();
  const bus = createBroadcast({ topology, sessionState });
  const c = fakeClient();
  bus.subscribe(c);
  const frames = c.frames();
  assert.deepEqual(frames.map((f) => f.event), ['topology', 'session-state']);
  assert.deepEqual({ ...frames[0].data, ...frames[1].data }, world().buildState(),
    'the pair is exactly the payload GET /state returns');
  assert.deepEqual(Object.keys(frames[1].data), ['sessions', 'servers'],
    'the hot half is only the sessions and their servers');
  assert.equal(bus.clients.size, 1);
});

test('hook traffic sends the session half only', () => {
  const { topology, sessionState } = world();
  const bus = createBroadcast({ topology, sessionState });
  const c = fakeClient();
  bus.subscribe(c);
  c.chunks.length = 0;
  bus.schedule();          // what manager.on('change') does — every Claude hook
  bus.flush();
  assert.deepEqual(c.frames().map((f) => f.event), ['session-state'],
    'a tool call must never make the server re-serialize every repo');
});

test('a topology-flagged broadcast sends both halves', () => {
  const { topology, sessionState } = world();
  const bus = createBroadcast({ topology, sessionState });
  const c = fakeClient();
  bus.subscribe(c);
  c.chunks.length = 0;
  bus.schedule({ topology: true });
  bus.flush();
  assert.deepEqual(c.frames().map((f) => f.event), ['topology', 'session-state']);
});

test('a burst is coalesced into one flush, 80 ms later by default', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { topology, sessionState } = world();
  const bus = createBroadcast({ topology, sessionState });
  const c = fakeClient();
  bus.subscribe(c);
  c.chunks.length = 0;
  for (let i = 0; i < 25; i++) bus.schedule();
  t.mock.timers.tick(79);
  assert.equal(c.chunks.length, 0, 'nothing goes out during the debounce window');
  t.mock.timers.tick(1);
  assert.deepEqual(c.frames().map((f) => f.event), ['session-state'], '25 hooks → one frame');
});

test('a topology flag raised anywhere in the window survives the coalescing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { topology, sessionState } = world();
  const bus = createBroadcast({ topology, sessionState });
  const c = fakeClient();
  bus.subscribe(c);
  c.chunks.length = 0;
  bus.schedule();                    // a hook opens the window
  bus.schedule({ topology: true });  // a rescan lands inside it
  bus.schedule();
  t.mock.timers.tick(80);
  assert.deepEqual(c.frames().map((f) => f.event), ['topology', 'session-state']);
  // and the flag is consumed, not sticky
  c.chunks.length = 0;
  bus.schedule();
  t.mock.timers.tick(80);
  assert.deepEqual(c.frames().map((f) => f.event), ['session-state']);
});

test('a closed session disappears — a replacement reports removals for free', () => {
  const { w, topology, sessionState } = world();
  const bus = createBroadcast({ topology, sessionState });
  const c = fakeClient();
  const client = refClient();
  bus.subscribe(c);
  c.frames().forEach(client.apply);
  assert.equal(client.state.repos[0].worktrees[0].session.id, 's_1');

  w.sessions = [];
  w.servers = {};
  c.chunks.length = 0;
  bus.schedule();
  bus.flush();
  c.frames().forEach(client.apply);
  assert.equal(client.state.repos[0].worktrees[0].session, null, 'the worktree row loses its agent');
  assert.equal(client.state.features[0].session, null);
});

test('a session-state frame refreshes the agent state embedded in the topology', () => {
  const { w, topology, sessionState } = world();
  const bus = createBroadcast({ topology, sessionState });
  const c = fakeClient();
  const client = refClient();
  bus.subscribe(c);
  c.frames().forEach(client.apply);
  assert.equal(client.state.repos[0].worktrees[0].session.state, 'idle');

  w.sessions[0].state = 'waiting'; // a Notification hook — no topology frame follows
  c.chunks.length = 0;
  bus.schedule();
  bus.flush();
  c.frames().forEach(client.apply);
  assert.equal(client.state.repos[0].worktrees[0].session.state, 'waiting', 'the Fleet row follows the agent');
  assert.equal(client.state.features[0].members[0].session.state, 'waiting', 'and so does the feature member');
});

test('connect snapshot + subsequent events converge on exactly a full rebuild', () => {
  const { w, topology, sessionState, buildState } = world();
  const bus = createBroadcast({ topology, sessionState });
  const early = fakeClient();
  const client = refClient();
  bus.subscribe(early);
  early.frames().forEach(client.apply);

  // a stream of hooks, a worktree appearing, the old session closing and a new one
  // adopting the new worktree — i.e. both halves changing, independently
  const steps = [
    () => { w.sessions[0].state = 'working'; w.sessions[0].activity = 'Bash(npm test)'; bus.schedule(); },
    () => { w.sessions[0].state = 'waiting'; bus.schedule(); },
    () => { w.worktrees.push({ wtname: 'feat-b', path: '/w/b', sessionId: null }); bus.schedule({ topology: true }); },
    () => {
      w.sessions = [{ id: 's_2', state: 'idle', activity: 'starting…', muxName: 'm2', title: 'B' }];
      w.servers = { s_2: { repos: [] } };
      w.worktrees[0].sessionId = null;
      w.worktrees[1].sessionId = 's_2';
      bus.schedule({ topology: true });
    },
    () => { w.sessions[0].state = 'working'; w.sessions[0].activity = 'Edit(app.js)'; bus.schedule(); },
  ];
  for (const step of steps) { early.chunks.length = 0; step(); bus.flush(); early.frames().forEach(client.apply); }

  assert.deepEqual(client.state, buildState(), 'the streamed client matches GET /state exactly');

  // …and a client that connects only now converges on the same thing from its
  // snapshot alone (this is also what an EventSource reconnect does).
  const late = fakeClient();
  const lateClient = refClient();
  bus.subscribe(late);
  late.frames().forEach(lateClient.apply);
  assert.deepEqual(lateClient.state, client.state, 'late joiner === streamed client');
});

test('a reconnecting client re-snapshots instead of drifting on what it missed', () => {
  const { w, topology, sessionState, buildState } = world();
  const bus = createBroadcast({ topology, sessionState });
  const c1 = fakeClient();
  const client = refClient();
  const unsubscribe = bus.subscribe(c1);
  c1.frames().forEach(client.apply);

  unsubscribe(); // the connection drops
  w.sessions[0].state = 'waiting';
  w.worktrees.push({ wtname: 'feat-b', path: '/w/b', sessionId: null });
  bus.schedule({ topology: true });
  bus.flush();
  assert.equal(client.state.repos[0].worktrees.length, 1, 'it genuinely missed that');

  const c2 = fakeClient(); // EventSource reconnects: a brand-new subscriber
  bus.subscribe(c2);
  c2.frames().forEach(client.apply);
  assert.deepEqual(client.state, buildState());
});

test('a client that went away does not break the fan-out for the others', () => {
  const { topology, sessionState } = world();
  const bus = createBroadcast({ topology, sessionState });
  const dead = { write() { throw new Error('EPIPE'); } };
  const live = fakeClient();
  bus.subscribe(dead);
  bus.subscribe(live);
  live.chunks.length = 0;
  bus.schedule({ topology: true });
  bus.flush();
  assert.deepEqual(live.frames().map((f) => f.event), ['topology', 'session-state']);
});

test('with nobody listening, a flush builds nothing', () => {
  let builds = 0;
  const { topology, sessionState } = world();
  const bus = createBroadcast({ topology: () => { builds++; return topology(); }, sessionState });
  bus.schedule({ topology: true });
  bus.flush();
  assert.equal(builds, 0);
});
