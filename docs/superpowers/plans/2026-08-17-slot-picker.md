# Slot Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a feature be started on a chosen concurrency slot and moved between slots while running, with a default policy that skips slots whose ports are already bound.

**Architecture:** One new read method on `Servers` — `slotReport(feature, members)` — computes per-slot occupancy for a *named feature's* member repos using the same `portPid` primitive `start()` pre-checks with. `allocSlotFor` becomes async, consults that report, and gains an explicit `requested` slot. `startAll` (the single choke point all three start routes share) threads the request through. Two new routes expose the report and a move operation. The client gets one `SlotMenu.svelte` serving both a start split-button and the slot badge.

**Tech Stack:** Node ≥22, TypeScript (type-stripping, `.ts` imports), `node --test` for server tests, SvelteKit 5 (runes) + vitest for the client, Biome for lint/format.

**Spec:** `docs/superpowers/specs/2026-08-17-slot-picker-design.md`

## Global Constraints

- Node ≥ 22; server runs `.ts` directly via type-stripping — **import paths keep their `.ts` extension** (`from './concurrency.ts'`).
- Server tests: `node --test test/*.test.ts`. Client tests: `npm --prefix client test`. Full gate: `npm test` (runs `typecheck` first).
- `npm run typecheck` = `tsc --noEmit && npm --prefix client run check`. It must pass before every commit.
- Svelte 5 runes only (`$state`, `$derived`, `$props`, `$effect`) — no Svelte 4 store syntax.
- **After changing anything in `client/src`, run `npm run build`** or the daemon serves a stale bundle.
- Slot 0 must stay byte-for-byte today's behavior for a single feature: no `slot` in a request body means no behavior change.
- Studio never signals a process it did not start. No task may add a kill path for an untracked pid.
- Existing public shapes that must not change: `startReport.report()` response shape, `SlotAllocation` (`{slot} | {error}`), `feature.slot` in the topology payload.
- Commit style: repo uses short imperative subjects, no AI-attribution trailers.

---

### Task 1: `SlotReport` type and `Servers.slotReport()`

The read model everything else consumes. Occupancy is computed for a named feature's member repos — never globally — because `start()` only pre-checks the ports *that repo* derives.

**Files:**
- Modify: `server/servers.ts` (add `SlotReport` interface near `SlotAllocation` at :81-82; add `slotReport()` method after `allocSlotFor`, ~:328)
- Test: `test/slot-report.test.ts` (create)

**Interfaces:**
- Consumes: `deriveEnv` from `server/concurrency.ts`; `this.portPid`, `this.slots`, `this._repoConc`, `this._concEnabled`, `this.cfg.concurrency`
- Produces:
  ```ts
  export interface SlotReport {
    slot: number;
    state: 'free' | 'held' | 'blocked' | 'current';
    /** repo name → the ports that repo derives on this slot. Only concurrency-governed repos appear. */
    ports: Record<string, number[]>;
    /** Set when state === 'held': the feature holding it. */
    heldBy?: string;
    /** Set when state === 'blocked': the first bound port and its pid. */
    blockedBy?: { port: number; pid: number };
  }
  ```
  and `async slotReport(feature: string, members: Array<{ repo: string; worktreePath: string }>): Promise<SlotReport[]>`

- [ ] **Step 1: Write the failing tests**

Create `test/slot-report.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Servers } from '../server/servers.ts';

// accept-blue + ab-su, the real shape of a two-repo feature.
const CONC = {
  enabled: true,
  offsetStep: 100,
  maxSlots: 3,
  repos: {
    'accept-blue': {
      portEnv: { api__port_su: 1231, api__port: 1233 },
      slotEnv: ['redis__db'],
    },
    'ab-su': { portEnv: { WTS_FE_PORT: 8000 } },
  },
};

/**
 * A Servers with concurrency configured and `portPid` stubbed.
 * `bound` maps port → pid; anything absent reads as free.
 */
function servers(bound: Record<number, number> = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-slotrep-'));
  const s = new Servers({
    _stateDir: stateDir,
    web: { port: 0 },
    start: { 'accept-blue': { cmd: ':', ports: [] }, 'ab-su': { cmd: ':', ports: [] } },
    concurrency: CONC,
  });
  s.portPid = async (port: number) => bound[port] ?? null;
  // featureFor() reads the identity strategy off real paths; these tests drive
  // slotReport directly, so members carry whatever paths we say.
  return s;
}

const BE = { repo: 'accept-blue', worktreePath: '/wt/be' };
const SU = { repo: 'ab-su', worktreePath: '/wt/su' };

test('slotReport derives each repo ports per slot', async () => {
  const r = await servers().slotReport('f', [BE, SU]);
  assert.equal(r.length, 3);
  assert.deepEqual(r[0].ports, { 'accept-blue': [1231, 1233], 'ab-su': [8000] });
  assert.deepEqual(r[2].ports, { 'accept-blue': [1431, 1433], 'ab-su': [8200] });
});

test('a slot whose ports are all unbound is free', async () => {
  const r = await servers().slotReport('f', [BE, SU]);
  assert.deepEqual(r.map((x) => x.state), ['free', 'free', 'free']);
});

test('a slot another feature holds is held, and names it', async () => {
  const s = servers();
  s.slots.set('iso-mfa-totp', 1);
  const r = await s.slotReport('f', [BE, SU]);
  assert.equal(r[1].state, 'held');
  assert.equal(r[1].heldBy, 'iso-mfa-totp');
});

test("the feature's own slot is current, not held", async () => {
  const s = servers();
  s.slots.set('f', 2);
  const r = await s.slotReport('f', [BE, SU]);
  assert.equal(r[2].state, 'current');
  assert.equal(r[2].heldBy, undefined);
});

test('an unheld slot with a bound port is blocked, and names port and pid', async () => {
  const r = await servers({ 1231: 54549 }).slotReport('f', [BE, SU]);
  assert.equal(r[0].state, 'blocked');
  assert.deepEqual(r[0].blockedBy, { port: 1231, pid: 54549 });
  assert.equal(r[1].state, 'free');
});

// The case a global occupancy model gets wrong, and the reason this API takes members.
test('a bound port belonging to a repo NOT in this feature leaves the slot free', async () => {
  const r = await servers({ 1231: 54549 }).slotReport('su-mfa-cleanup', [SU]);
  assert.equal(r[0].state, 'free', 'ab-su only needs 8000 on slot 0');
  assert.deepEqual(r[0].ports, { 'ab-su': [8000] });
});

test('held beats blocked — a held slot is not port-probed', async () => {
  const s = servers({ 1331: 999 });
  s.slots.set('other', 1);
  const r = await s.slotReport('f', [BE]);
  assert.equal(r[1].state, 'held');
  assert.equal(r[1].blockedBy, undefined);
});

test('a repo with no concurrency config contributes no ports', async () => {
  const r = await servers().slotReport('f', [{ repo: 'unmapped', worktreePath: '/wt/x' }]);
  assert.deepEqual(r[0].ports, {});
  assert.equal(r[0].state, 'free');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/slot-report.test.ts`
Expected: FAIL — `s.slotReport is not a function`

- [ ] **Step 3: Implement `SlotReport` and `slotReport()`**

In `server/servers.ts`, beside the existing `SlotAllocation` (~:81):

```ts
/** One slot's availability, judged for a specific feature's repos. */
export interface SlotReport {
  slot: number;
  state: 'free' | 'held' | 'blocked' | 'current';
  /** repo name → the ports that repo derives on this slot. Only concurrency-governed repos appear. */
  ports: Record<string, number[]>;
  /** Set when state === 'held': the feature holding it. */
  heldBy?: string;
  /** Set when state === 'blocked': the first bound port and its pid. */
  blockedBy?: { port: number; pid: number };
}
```

Add the method immediately after `allocSlotFor`:

```ts
  /**
   * Every slot's availability FOR THIS FEATURE.
   *
   * There is no global answer. `start()` pre-checks only the ports the repo being
   * launched derives, so a slot is usable or not depending on which repos are asking:
   * an FE-only feature is happy on a slot whose backend ports are occupied, because it
   * never binds them. Judging slots globally would grey out starts that work.
   *
   * Reads only — allocates nothing, persists nothing. Uses the same `portPid` the
   * launch pre-check uses, so the picker and the launch cannot disagree.
   */
  async slotReport(
    feature: string,
    members: Array<{ repo: string; worktreePath: string }>,
  ): Promise<SlotReport[]> {
    const conc = this.cfg.concurrency;
    const on = this._concEnabled() && !!conc;
    const max = on ? conc!.maxSlots || 1 : 1;
    const step = on ? conc!.offsetStep : 0;
    // slot → the OTHER feature holding it. The caller's own slot is `current`, not held.
    const holder = new Map<number, string>();
    for (const [f, s] of this.slots) if (f !== feature) holder.set(s, f);
    const mine = this.slots.get(feature);

    const out: SlotReport[] = [];
    for (let slot = 0; slot < max; slot++) {
      const ports: Record<string, number[]> = {};
      for (const m of members) {
        const rc = this._repoConc(m.repo);
        if (rc) ports[m.repo] = deriveEnv(rc, slot, step).ports;
      }
      if (mine === slot) {
        out.push({ slot, state: 'current', ports });
        continue;
      }
      const heldBy = holder.get(slot);
      if (heldBy !== undefined) {
        out.push({ slot, state: 'held', ports, heldBy });
        continue;
      }
      let blockedBy: { port: number; pid: number } | undefined;
      for (const ps of Object.values(ports)) {
        for (const p of ps) {
          const pid = await this.portPid(p);
          if (pid) {
            blockedBy = { port: p, pid };
            break;
          }
        }
        if (blockedBy) break;
      }
      out.push(blockedBy ? { slot, state: 'blocked', ports, blockedBy } : { slot, state: 'free', ports });
    }
    return out;
  }
```

`deriveEnv` is already imported by `servers.ts`; confirm the import line includes it and add it if not.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/slot-report.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add server/servers.ts test/slot-report.test.ts
git commit -m "slotReport(): per-feature slot availability"
```

---

### Task 2: `allocSlotFor` gains a requested slot and a free-ports policy

**Files:**
- Modify: `server/servers.ts:315-328` (`allocSlotFor`)
- Modify: `server/types.ts:148-154` (`ConcurrencyConfig`)
- Test: `test/slot-alloc.test.ts` (create)

**Interfaces:**
- Consumes: `slotReport()` from Task 1; `allocSlot` from `server/concurrency.ts`
- Produces: `async allocSlotFor(feature: string, opts?: { requested?: number; members?: Array<{ repo: string; worktreePath: string }> }): Promise<SlotAllocation>` — **now async**; `ConcurrencyConfig.slotPolicy?: 'free-ports' | 'lowest'`

- [ ] **Step 1: Write the failing tests**

Create `test/slot-alloc.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Servers } from '../server/servers.ts';

const CONC = {
  enabled: true,
  offsetStep: 100,
  maxSlots: 3,
  repos: { 'accept-blue': { portEnv: { api__port_su: 1231 } } },
};

function servers(bound: Record<number, number> = {}, extraConc = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-slotalloc-'));
  const s = new Servers({
    _stateDir: stateDir,
    web: { port: 0 },
    start: { 'accept-blue': { cmd: ':', ports: [] } },
    concurrency: { ...CONC, ...extraConc },
  });
  s.portPid = async (port: number) => bound[port] ?? null;
  return s;
}

const BE = [{ repo: 'accept-blue', worktreePath: '/wt/be' }];

test('a feature that already holds a slot keeps it', async () => {
  const s = servers();
  s.slots.set('f', 2);
  assert.deepEqual(await s.allocSlotFor('f', { members: BE }), { slot: 2 });
});

test('default policy skips a slot whose ports are bound', async () => {
  const s = servers({ 1231: 54549 });
  assert.deepEqual(await s.allocSlotFor('f', { members: BE }), { slot: 1 });
});

test('default policy skips a held slot too', async () => {
  const s = servers();
  s.slots.set('other', 0);
  assert.deepEqual(await s.allocSlotFor('f', { members: BE }), { slot: 1 });
});

test('a free requested slot is honored', async () => {
  const s = servers();
  assert.deepEqual(await s.allocSlotFor('f', { requested: 2, members: BE }), { slot: 2 });
  assert.equal(s.slots.get('f'), 2);
});

test('a held requested slot is refused and names the holder', async () => {
  const s = servers();
  s.slots.set('iso-mfa-totp', 1);
  const r = await s.allocSlotFor('f', { requested: 1, members: BE });
  assert.match(String(r.error), /held by iso-mfa-totp/);
  assert.equal(r.slot, undefined);
  assert.equal(s.slots.has('f'), false, 'a refused request allocates nothing');
});

test('a blocked requested slot is refused and names port and pid', async () => {
  const s = servers({ 1231: 54549 });
  const r = await s.allocSlotFor('f', { requested: 0, members: BE });
  assert.match(String(r.error), /1231/);
  assert.match(String(r.error), /54549/);
});

test('a requested slot is never silently substituted', async () => {
  const s = servers({ 1231: 54549 });
  const r = await s.allocSlotFor('f', { requested: 0, members: BE });
  assert.equal(r.slot, undefined, 'refuse, do not hand back slot 1');
});

test('an out-of-range request is refused', async () => {
  const r = await servers().allocSlotFor('f', { requested: 7, members: BE });
  assert.match(String(r.error), /does not exist/);
});

test('every slot blocked falls back to the lowest unheld slot rather than refusing', async () => {
  const s = servers({ 1231: 1, 1331: 2, 1431: 3 });
  assert.deepEqual(await s.allocSlotFor('f', { members: BE }), { slot: 0 });
});

test('all slots held is still an error', async () => {
  const s = servers();
  s.slots.set('a', 0);
  s.slots.set('b', 1);
  s.slots.set('c', 2);
  const r = await s.allocSlotFor('f', { members: BE });
  assert.match(String(r.error), /no free concurrency slot/);
});

test("policy 'lowest' ignores bound ports", async () => {
  const s = servers({ 1231: 54549 }, { slotPolicy: 'lowest' });
  assert.deepEqual(await s.allocSlotFor('f', { members: BE }), { slot: 0 });
});

test('concurrency off answers slot 0', async () => {
  const s = servers({}, { enabled: false });
  assert.deepEqual(await s.allocSlotFor('f', { members: BE }), { slot: 0 });
});

test('no members behaves as today — lowest unheld slot', async () => {
  const s = servers({ 1231: 54549 });
  s.slots.set('other', 0);
  assert.deepEqual(await s.allocSlotFor('f', {}), { slot: 1 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/slot-alloc.test.ts`
Expected: FAIL — the requested-slot tests fail because `opts` is ignored, and the async tests get a non-promise.

- [ ] **Step 3: Add `slotPolicy` to the config type**

In `server/types.ts`, inside `ConcurrencyConfig`:

```ts
  /**
   * How a slot is chosen when the caller does not name one.
   *   'free-ports' — lowest slot whose ports are all unbound (default). Skips a slot a
   *                  process Studio does not track is sitting on, which is otherwise a
   *                  launch that fails only after you committed to it.
   *   'lowest'     — lowest slot no feature holds, regardless of what is listening.
   */
  slotPolicy?: 'free-ports' | 'lowest';
```

- [ ] **Step 4: Rewrite `allocSlotFor`**

Replace the body at `server/servers.ts:315-328`:

```ts
  /**
   * Allocate (or reuse) the feature's slot.
   *
   * `requested` is the user naming a slot in the picker. It is honored when free and
   * REFUSED with a reason otherwise — never silently moved to a different slot, because
   * the whole point of asking is to land somewhere specific.
   *
   * With nothing requested, `slotPolicy` decides. 'free-ports' consults live port state
   * so a slot some untracked process is sitting on is skipped rather than handed out and
   * failed on at launch. When EVERY slot is blocked it falls back to the lowest unheld
   * one: refusing to start at all would be worse than starting and hitting the existing
   * port pre-check, which names the pid.
   *
   * Async because the policy reads reality. All three callers already await.
   */
  async allocSlotFor(
    feature: string,
    opts: {
      requested?: number;
      members?: Array<{ repo: string; worktreePath: string }>;
    } = {},
  ): Promise<SlotAllocation> {
    const conc = this.cfg.concurrency;
    if (!this._concEnabled() || !conc || !feature) return { slot: 0 };
    const max = conc.maxSlots || 1;
    const held = this.slots.get(feature);
    const { requested, members = [] } = opts;
    if (requested === undefined && held !== undefined) return { slot: held };

    const take = (slot: number): SlotAllocation => {
      this.slots.set(feature, slot);
      this._save();
      return { slot };
    };

    if (requested !== undefined) {
      if (!Number.isInteger(requested) || requested < 0 || requested >= max) {
        return { error: `slot ${requested} does not exist (0–${max - 1})` };
      }
      if (held === requested) return { slot: held };
      const r = (await this.slotReport(feature, members))[requested];
      if (r.state === 'held') return { error: `slot ${requested} is held by ${r.heldBy}` };
      if (r.state === 'blocked') {
        return {
          error: `slot ${requested}: port ${r.blockedBy!.port} is in use by pid ${r.blockedBy!.pid}`,
        };
      }
      return take(requested);
    }

    if ((conc.slotPolicy ?? 'free-ports') === 'free-ports') {
      const free = (await this.slotReport(feature, members)).find((r) => r.state === 'free');
      if (free) return take(free.slot);
      // Every slot blocked or held — fall through to the held-only view.
    }
    const slot = allocSlot(new Set(this.slots.values()), max);
    if (slot === null) return { error: `no free concurrency slot (max ${max} running)` };
    return take(slot);
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/slot-alloc.test.ts`
Expected: PASS, 13 tests

- [ ] **Step 6: Commit**

```bash
npm run typecheck
git add server/servers.ts server/types.ts test/slot-alloc.test.ts
git commit -m "allocSlotFor: honor a requested slot, skip slots whose ports are bound"
```

---

### Task 3: Thread the requested slot through `startAll` and fix the async callers

`allocSlotFor` is now async and takes members, so its three call sites must pass them and await. `startAll` also stops allocating per-target and starts allocating per-feature, which is what it always meant.

**Files:**
- Modify: `server/servers.ts:987-1005` (`startAll`)
- Modify: `server/server.ts:1047-1063` (`/servers/restart`)
- Modify: `server/orchestrator.ts:283-300` (`/group/restart`)
- Modify: `server/orchestrator.ts:61` (the `Servers` interface the orchestrator narrows to)
- Test: `test/slot-alloc.test.ts` (extend)

**Interfaces:**
- Consumes: `allocSlotFor` from Task 2
- Produces: `async startAll(targets: Array<{ repo: string; worktreePath: string }>, opts?: { slot?: number }): Promise<{ ok: false; slotError: string } | { ok: true; results: Array<{ repo: string } & StartResult> }>`

- [ ] **Step 1: Write the failing tests**

Append to `test/slot-alloc.test.ts`:

```ts
test('startAll allocates every slot before launching anything', async () => {
  const s = servers();
  s.slots.set('a', 0);
  s.slots.set('b', 1);
  s.slots.set('c', 2);
  let launched = 0;
  s.start = async () => { launched++; return { ok: true }; };
  s.featureFor = () => 'f';
  const out = await s.startAll([{ repo: 'accept-blue', worktreePath: '/wt/be' }]);
  assert.equal(out.ok, false);
  assert.equal(launched, 0, 'a refused slot spawns nothing');
});

test('startAll passes a requested slot through and refuses cleanly', async () => {
  const s = servers({ 1231: 54549 });
  let launched = 0;
  s.start = async () => { launched++; return { ok: true }; };
  s.featureFor = () => 'f';
  const out = await s.startAll([{ repo: 'accept-blue', worktreePath: '/wt/be' }], { slot: 0 });
  assert.equal(out.ok, false);
  assert.match(String(out.slotError), /54549/);
  assert.equal(launched, 0);
});

test('startAll allocates once per feature, not once per target', async () => {
  const s = servers();
  s.start = async () => ({ ok: true });
  s.featureFor = () => 'f';
  const out = await s.startAll([
    { repo: 'accept-blue', worktreePath: '/wt/be' },
    { repo: 'ab-su', worktreePath: '/wt/su' },
  ], { slot: 2 });
  assert.equal(out.ok, true);
  assert.equal(s.slots.get('f'), 2);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/slot-alloc.test.ts`
Expected: FAIL — `startAll` does not accept `opts`, and its allocation loop is not awaited.

- [ ] **Step 3: Rewrite `startAll`**

Replace the allocation loop at `server/servers.ts:987-1005`. Keep the surrounding doc comment; append a line about grouping.

```ts
  async startAll(
    targets: Array<{ repo: string; worktreePath: string }>,
    opts: { slot?: number } = {},
  ): Promise<
    { ok: false; slotError: string } | { ok: true; results: Array<{ repo: string } & StartResult> }
  > {
    // Group first: a slot belongs to a FEATURE, and allocSlotFor now judges availability
    // against that feature's member repos. Allocating per target asked the same question
    // once per repo and could not see the whole port set.
    const byFeature = new Map<string, Array<{ repo: string; worktreePath: string }>>();
    for (const t of targets) {
      const f = this.featureFor(t.worktreePath);
      const list = byFeature.get(f);
      if (list) list.push(t);
      else byFeature.set(f, [t]);
    }
    for (const [feature, members] of byFeature) {
      const alloc = await this.allocSlotFor(feature, { requested: opts.slot, members });
      if (alloc.error) return { ok: false, slotError: alloc.error };
    }
    const results = await Promise.all(
      targets.map(async (t) => {
        const feature = this.featureFor(t.worktreePath);
        return {
          repo: t.repo,
          ...(await this.start(t.repo, t.worktreePath, this.launchOpts(t.repo, feature))),
        };
      }),
    );
    return { ok: true, results };
  }
```

- [ ] **Step 4: Update `/servers/restart`**

In `server/server.ts` (~:1053), replace the alloc line:

```ts
    const feature = servers.featureFor(worktreePath);
    // reuse the feature's slot across the restart
    const alloc = await servers.allocSlotFor(feature, { members: [{ repo, worktreePath }] });
    if (alloc.error) return res.status(409).json({ ok: false, error: alloc.error });
```

- [ ] **Step 5: Update `/group/restart`**

In `server/orchestrator.ts` (~:293), replace the per-member alloc loop:

```ts
    for (const m of toRestart) {
      const feature = servers.featureFor(m.path);
      const alloc = await servers.allocSlotFor(feature, {
        members: toRestart.filter((x) => servers.featureFor(x.path) === feature)
          .map((x) => ({ repo: x.repo, worktreePath: x.path })),
      });
      if (alloc.error) return res.status(409).json({ ok: false, error: alloc.error });
    }
```

- [ ] **Step 6: Update the orchestrator's narrowed `Servers` interface**

In `server/orchestrator.ts` (~:61), the declaration must match the new signature or `tsc` fails:

```ts
  allocSlotFor(
    feature: string,
    opts?: { requested?: number; members?: Array<{ repo: string; worktreePath: string }> },
  ): Promise<{ slot?: number; error?: string }>;
  slotReport(
    feature: string,
    members: Array<{ repo: string; worktreePath: string }>,
  ): Promise<SlotReport[]>;
  startAll(
    targets: Array<{ repo: string; worktreePath: string }>,
    opts?: { slot?: number },
  ): Promise<{ ok: false; slotError: string } | { ok: true; results: Array<{ repo: string } & Record<string, unknown>> }>;
```

Import `SlotReport` from `./servers.ts` at the top of `orchestrator.ts`. If `startAll` is not already on that interface, add it; check the existing declaration first and match its result type rather than widening it.

- [ ] **Step 7: Run the full server suite**

Run: `node --test test/*.test.ts`
Expected: PASS — including the pre-existing `test/concurrency-wiring.test.ts`, which exercises these call sites.

- [ ] **Step 8: Commit**

```bash
npm run typecheck
git add server/servers.ts server/server.ts server/orchestrator.ts test/slot-alloc.test.ts
git commit -m "startAll: allocate per feature and accept a requested slot"
```

---

### Task 4: `GET /group/:name/slots`

**Files:**
- Modify: `server/orchestrator.ts` (register beside the other `/group` routes)
- Test: `test/slot-routes.test.ts` (create)

**Interfaces:**
- Consumes: `slotReport` (Task 1), `resolveGroup` from `OrchestratorDeps`
- Produces: `GET /api/v1/group/:name/slots` → `SlotReport[]`; 404 `{ error: 'no such feature' }` for an unknown name

- [ ] **Step 1: Write the failing test**

Create `test/slot-routes.test.ts`. Follow the harness in `test/route-validation.test.ts` — read it first and mirror how it builds a router with stub deps.

```ts
import { test } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { register } from '../server/orchestrator.ts';

/**
 * A router with orchestrator routes mounted over stub deps.
 *
 * `servers` is merged, not replaced — a trailing spread of the whole override object
 * would clobber the stub Servers with whichever one or two methods a test overrode.
 */
function app({ servers: serverOverrides = {}, ...overrides }: Record<string, any> = {}) {
  const a = express();
  a.use(express.json());
  const members = [
    { repo: 'accept-blue', path: '/wt/be', ports: [], running: true, canStart: true },
    { repo: 'ab-su', path: '/wt/su', ports: [], running: true, canStart: true },
  ];
  const deps = {
    cfg: { concurrency: { enabled: true, offsetStep: 100, maxSlots: 3, repos: {} } },
    servers: {
      featureFor: () => 'f',
      slotReport: async () => [
        { slot: 0, state: 'blocked', ports: {}, blockedBy: { port: 1231, pid: 54549 } },
        { slot: 1, state: 'free', ports: {} },
        { slot: 2, state: 'current', ports: {} },
      ],
      slots: new Map([['f', 2]]),
      stop: async () => ({ ok: true }),
      releaseSlot: () => {},
      allocSlotFor: async () => ({ slot: 1 }),
      startAll: async () => ({ ok: true, results: [] }),
      ...serverOverrides,
    },
    resolveGroup: async (name: string) =>
      name === 'f' ? { group: { name: 'f', members }, flat: members } : { group: null, flat: [] },
    conflictsFor: () => [],
    refreshRunning: async () => {},
    running: () => new Map(),
    scheduleBroadcast: () => {},
    rescan: async () => {},
    manager: {},
    repos: () => [],
    ...overrides,
  };
  register(a, deps as never);
  return a;
}

async function call(a: express.Express, method: string, url: string, body?: unknown) {
  const { createServer } = await import('node:http');
  const srv = createServer(a);
  await new Promise<void>((r) => srv.listen(0, r));
  const { port } = srv.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  srv.close();
  return { status: res.status, json };
}

test('GET /group/:name/slots returns the report', async () => {
  const r = await call(app(), 'GET', '/group/f/slots');
  assert.equal(r.status, 200);
  assert.equal(r.json.length, 3);
  assert.equal(r.json[0].state, 'blocked');
  assert.deepEqual(r.json[0].blockedBy, { port: 1231, pid: 54549 });
});

test('GET /group/:name/slots 404s for an unknown feature', async () => {
  const r = await call(app(), 'GET', '/group/nope/slots');
  assert.equal(r.status, 404);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/slot-routes.test.ts`
Expected: FAIL — 404 for `/group/f/slots` (route not registered)

- [ ] **Step 3: Register the route**

In `server/orchestrator.ts`, beside the other `/group` routes:

```ts
  /*
   * Every slot's availability for this feature.
   *
   * Deliberately a request, not part of the topology frame: occupancy depends on live
   * port state, and computing it for every feature several times a second would put an
   * lsof per slot per feature on the broadcast path.
   */
  app.get('/group/:name/slots', async (req, res) => {
    const { group: g } = await resolveGroup(String(req.params.name ?? ''));
    if (!g) return res.status(404).json({ error: 'no such feature' });
    const feature = servers.featureFor(g.members[0].path);
    const members = g.members.map((m) => ({ repo: m.repo, worktreePath: m.path }));
    res.json(await servers.slotReport(feature, members));
  });
```

Guard the empty-members case: if `g.members.length === 0`, answer `res.json([])`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/slot-routes.test.ts`
Expected: PASS, 2 tests

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add server/orchestrator.ts test/slot-routes.test.ts
git commit -m "GET /group/:name/slots"
```

---

### Task 5: `POST /group/start` accepts a slot, `POST /group/slot` moves a feature

The move's load-bearing rule: **verify before stopping**. A feature left half-moved — backend on the new slot, frontend dead — is worse than no move.

**Files:**
- Modify: `server/orchestrator.ts` (`/group/start` body; new `/group/slot` route; `GroupBody`)
- Test: `test/slot-routes.test.ts` (extend)

**Interfaces:**
- Consumes: `startAll(targets, { slot })` (Task 3), `slotReport` (Task 1)
- Produces: `POST /api/v1/group/start { group, stopConflicts?, slot? }`; `POST /api/v1/group/slot { group, slot }` → `startReport.report(...)` shape, or 409 `{ ok: false, error }`

- [ ] **Step 1: Write the failing tests**

Append to `test/slot-routes.test.ts`:

```ts
test('POST /group/slot refuses an unavailable slot WITHOUT stopping anything', async () => {
  let stopped = 0;
  const a = app({ servers: { stop: async () => { stopped++; return { ok: true }; } } });
  const r = await call(a, 'POST', '/group/slot', { group: 'f', slot: 0 }); // slot 0 is blocked
  assert.equal(r.status, 409);
  assert.match(String(r.json.error), /54549/);
  assert.equal(stopped, 0, 'nothing may be stopped before the target is known good');
});

test('POST /group/slot stops, re-allocates, and restarts on the new slot', async () => {
  const order: string[] = [];
  const a = app({
    servers: {
      stop: async () => { order.push('stop'); return { ok: true }; },
      releaseSlot: () => order.push('release'),
      allocSlotFor: async (_f: string, o: { requested?: number }) => {
        order.push(`alloc:${o?.requested}`);
        return { slot: o?.requested ?? 0 };
      },
      startAll: async () => { order.push('start'); return { ok: true, results: [] }; },
    },
  });
  const r = await call(a, 'POST', '/group/slot', { group: 'f', slot: 1 });
  assert.equal(r.status, 200);
  assert.deepEqual(order, ['stop', 'stop', 'release', 'alloc:1', 'start']);
});

test('POST /group/slot 409s if the slot is taken during the stop', async () => {
  const a = app({
    servers: {
      allocSlotFor: async () => ({ error: 'slot 1 is held by other' }),
    },
  });
  const r = await call(a, 'POST', '/group/slot', { group: 'f', slot: 1 });
  assert.equal(r.status, 409);
  assert.match(String(r.json.error), /held by other/);
});

test('POST /group/slot rejects a non-integer slot', async () => {
  const r = await call(app(), 'POST', '/group/slot', { group: 'f', slot: 'x' });
  assert.equal(r.status, 400);
});

test('POST /group/start forwards slot to startAll', async () => {
  let got: unknown;
  const a = app({
    servers: {
      startAll: async (_t: unknown, o: { slot?: number }) => { got = o?.slot; return { ok: true, results: [] }; },
    },
  });
  await call(a, 'POST', '/group/start', { group: 'f', slot: 2 });
  assert.equal(got, 2);
});

test('POST /group/start with no slot forwards undefined', async () => {
  let got: unknown = 'unset';
  const a = app({
    servers: {
      startAll: async (_t: unknown, o: { slot?: number }) => { got = o?.slot; return { ok: true, results: [] }; },
    },
  });
  await call(a, 'POST', '/group/start', { group: 'f' });
  assert.equal(got, undefined, 'the default path must not pin slot 0');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/slot-routes.test.ts`
Expected: FAIL — `/group/slot` 404s, and `/group/start` ignores `slot`.

- [ ] **Step 3: Add `slot` to `GroupBody` and forward it from `/group/start`**

In `GroupBody` (`server/orchestrator.ts:173-181`) add:

```ts
  /** The slot the user picked, or absent for the default policy. */
  slot?: unknown;
```

In `/group/start`, destructure it and coerce, then pass it to `startAll`:

```ts
    const { group, stopConflicts, slot }: GroupBody = req.body || {};
```

and replace the `startAll` call:

```ts
    const out = await servers.startAll(
      toStart.map((m) => ({ repo: m.repo, worktreePath: m.path })),
      slot === undefined ? {} : { slot: Number(slot) },
    );
```

- [ ] **Step 4: Add the move route**

```ts
  /*
   * Move a running feature to another slot.
   *
   * Necessarily a restart: ports come from env read at launch, and the FE config patch is
   * written to the worktree before spawn, so nothing slides across live.
   *
   * The target is verified BEFORE anything is stopped. Verifying after would allow a
   * half-moved feature — backend on the new slot, frontend dead — which is strictly worse
   * than not moving. The re-allocation after the stop is still the authority: another
   * feature can take the slot in the gap, and then this answers 409 with the feature down,
   * which the client says plainly.
   */
  app.post('/group/slot', async (req, res) => {
    const { group, slot }: GroupBody = req.body || {};
    const want = Number(slot);
    if (!Number.isInteger(want) || want < 0) {
      return res.status(400).json({ ok: false, error: 'slot must be a non-negative integer' });
    }
    const { group: g } = await resolveGroup(String(group ?? ''));
    if (!g) return res.status(404).json({ error: 'no such feature' });
    if (!g.members.length) return res.status(400).json({ ok: false, error: 'feature has no members' });

    const feature = servers.featureFor(g.members[0].path);
    const members = g.members.map((m) => ({ repo: m.repo, worktreePath: m.path }));

    const report = await servers.slotReport(feature, members);
    const target = report[want];
    if (!target) return res.status(400).json({ ok: false, error: `slot ${want} does not exist` });
    if (target.state === 'current') return res.json({ ok: true, started: 0, total: 0 });
    if (target.state === 'held') {
      return res.status(409).json({ ok: false, error: `slot ${want} is held by ${target.heldBy}` });
    }
    if (target.state === 'blocked') {
      return res.status(409).json({
        ok: false,
        error: `slot ${want}: port ${target.blockedBy!.port} is in use by pid ${target.blockedBy!.pid}`,
      });
    }

    // Only members that were running come back up; a stopped one joins the new slot
    // whenever it is next started.
    const wasRunning = g.members.filter((m) => m.running);
    for (const m of wasRunning) await servers.stop(m.repo, m.path, m.ports);
    await refreshRunning();

    servers.releaseSlot(feature);
    const alloc = await servers.allocSlotFor(feature, { requested: want, members });
    if (alloc.error) return res.status(409).json({ ok: false, error: alloc.error });

    const out = await servers.startAll(
      wasRunning.map((m) => ({ repo: m.repo, worktreePath: m.path })),
      { slot: want },
    );
    if (!out.ok) return res.status(409).json({ ok: false, error: out.slotError });
    await refreshRunning();
    scheduleBroadcast();
    res.json(startReport.report(out.results));
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/slot-routes.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 6: Run the full server suite and commit**

```bash
node --test test/*.test.ts
npm run typecheck
git add server/orchestrator.ts test/slot-routes.test.ts
git commit -m "POST /group/slot moves a feature between slots"
```

---

### Task 6: `SlotMenu.svelte`

One component, two callers. It fetches the report itself so neither caller duplicates the endpoint.

**Files:**
- Create: `client/src/lib/components/SlotMenu.svelte`
- Test: `client/src/lib/components/SlotMenu.test.ts` (create)

**Interfaces:**
- Consumes: `GET /api/v1/group/:name/slots` (Task 4) via `api` from `$lib/api.js`
- Produces: props `{ feature: string; mode: 'start' | 'move'; onpick: (slot: number) => void; onclose: () => void }`

- [ ] **Step 1: Write the failing test**

Read `client/src/lib/components/ActionBar.test.ts` first and mirror its rendering approach. Create `SlotMenu.test.ts` asserting:

```ts
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import SlotMenu from './SlotMenu.svelte';

vi.mock('$lib/api.js', () => ({
  api: vi.fn(async () => [
    { slot: 0, state: 'blocked', ports: { 'accept-blue': [1231] }, blockedBy: { port: 1231, pid: 54549 } },
    { slot: 1, state: 'held', ports: {}, heldBy: 'iso-mfa-totp' },
    { slot: 2, state: 'free', ports: { 'accept-blue': [1431] } },
  ]),
}));

describe('SlotMenu', () => {
  it('disables blocked and held rows and gives each a reason', async () => {
    render(SlotMenu, { feature: 'f', mode: 'start', onpick: () => {}, onclose: () => {} });
    const blocked = await screen.findByRole('menuitem', { name: /slot 0/i });
    expect(blocked).toBeDisabled();
    expect(blocked.textContent).toMatch(/54549/);
    const held = await screen.findByRole('menuitem', { name: /slot 1/i });
    expect(held).toBeDisabled();
    expect(held.textContent).toMatch(/iso-mfa-totp/);
  });

  it('calls onpick with the chosen slot', async () => {
    const onpick = vi.fn();
    render(SlotMenu, { feature: 'f', mode: 'start', onpick, onclose: () => {} });
    (await screen.findByRole('menuitem', { name: /slot 2/i })).click();
    expect(onpick).toHaveBeenCalledWith(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix client test -- SlotMenu`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the component**

Build it from the mockup's markup (https://claude.ai/code/artifact/1f2b112c-7177-4f16-934f-31c7ebd5409b, sections 01 and 02). Requirements:

- `$effect` fetches `/api/v1/group/${encodeURIComponent(feature)}/slots` on mount; show "Reading slots…" until it resolves and the error text via `errMessage` on failure.
- One `<button role="menuitem">` per report entry. Accessible name must start with `Slot {n}` so the tests above can find it.
- `disabled` when `state` is `held`, `blocked`, or `current`.
- Row line 2: the derived ports joined as `repo 1431·1433`; for `held`, `held by {heldBy}`; for `blocked`, `{repo} {port} held by pid {pid}`.
- A state pill reading `free` / `in use` / `blocked`, or the word `current` for the feature's own slot.
- Heading: `Start on slot` in `start` mode, `Move to slot` in `move` mode, followed by the member repo names.
- Escape and outside-click call `onclose`. Use the existing `trapFocus` action from `$lib/actions/trapFocus.js` if `OverflowMenu.svelte` does — match that component's dismissal pattern rather than inventing one.
- Styling: reuse the existing token classes; `--working`/`--working-bg` for the slot tag, `--done`/`--done-bg` for free, `--waiting`/`--waiting-bg` for in use, `--del`/`--del-bg` for blocked. `max-height:min(62vh,420px); overflow-y:auto` since five slots is a tall list.

- [ ] **Step 4: Run to verify it passes**

Run: `npm --prefix client test -- SlotMenu`
Expected: PASS, 2 tests

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add client/src/lib/components/SlotMenu.svelte client/src/lib/components/SlotMenu.test.ts
git commit -m "SlotMenu: pick a slot, with occupancy and reasons"
```

---

### Task 7: Wire the picker into the action bar and the slot badge

**Files:**
- Modify: `client/src/lib/ops.svelte.ts:592-612` (`runStack`), plus a new `moveSlot`
- Modify: `client/src/lib/components/ActionBar.svelte:~143` (the feature button group)
- Modify: `client/src/lib/components/dock/FeaturePane.svelte:76-78` (slot badge)
- Modify: `client/src/lib/components/rail/FeatureCard.svelte:108-110` (slot badge)
- Test: `client/src/lib/components/ActionBar.test.ts` (extend)

**Interfaces:**
- Consumes: `SlotMenu` (Task 6); `POST /group/start { slot }` and `POST /group/slot` (Task 5)
- Produces: `runStack(name: string, slot?: number)`; `moveSlot(name: string, slot: number)`

- [ ] **Step 1: Write the failing test**

Extend `ActionBar.test.ts` with a case asserting the caret button exists for a feature target and is labelled `Choose a slot`, and that `▶ Start` still calls `runStack` with one argument.

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix client test -- ActionBar`
Expected: FAIL — no caret button

- [ ] **Step 3: Extend `runStack` and add `moveSlot`**

In `ops.svelte.ts`, `runStack` takes an optional slot and includes it in both posts (the initial one and the `stopConflicts` retry — dropping it on the retry would silently move the feature):

```ts
export function runStack(name: string, slot?: number) {
  return pending.run(name, async () => {
    try {
      const body = slot === undefined ? { group: name } : { group: name, slot };
      const r = await api('POST', '/api/v1/group/start', body);
      if (r.needsConfirm) {
        // …existing confirm text, unchanged…
        if (!ok) return;
        const r2 = await api('POST', '/api/v1/group/start', { ...body, stopConflicts: true });
        toast(startResult('Switched — started', r2), !r2.ok);
      } else {
        toast(startResult('Started', r), !r.ok);
      }
    } catch (e) {
      toast(errMessage(e), true);
    }
  });
}

/**
 * Move a feature to another slot. A restart, not a slide — the confirm says so, because
 * ports come from env read at launch.
 */
export async function moveSlot(name: string, slot: number, summary: string) {
  const ok = await uiConfirm(summary, { title: `Move “${name}” to slot ${slot}?`, okLabel: 'Move & restart' });
  if (!ok) return;
  return pending.run(name, async () => {
    try {
      const r = await api('POST', '/api/v1/group/slot', { group: name, slot });
      toast(startResult(`Moved to slot ${slot} — started`, r), !r.ok);
    } catch (e) {
      toast(errMessage(e), true);
    }
  });
}
```

`summary` is built by the caller from the `SlotMenu` report entry it already has — the before/after port lines from the mockup's section 03.

- [ ] **Step 4: Add the split button to `ActionBar.svelte`**

Beside the existing feature ▶/■/↻ group: keep `▶ Start` calling `runStack(target.name)` unchanged, and add an adjacent caret button (`aria-haspopup="menu"`, `aria-label="Choose a slot"`) that toggles a `SlotMenu` in `start` mode. `onpick` calls `runStack(target.name, slot)`.

- [ ] **Step 5: Make both slot badges the move control**

In `FeaturePane.svelte` and `FeatureCard.svelte`, turn the `<span class="badge slot">` into a `<button class="badge slot">` with `aria-haspopup="menu"` that opens `SlotMenu` in `move` mode. Keep the existing `title`. `onpick` calls `moveSlot(feature.name, slot, summary)`. In `FeatureCard.svelte` the badge sits inside a clickable card — call `e.stopPropagation()` so opening the menu does not also select the card.

- [ ] **Step 6: Run client tests and build**

```bash
npm --prefix client test
npm run build
```
Expected: PASS, and a fresh bundle.

- [ ] **Step 7: Commit**

```bash
npm run typecheck
git add client/src
git commit -m "Pick a slot from the action bar, move one from the slot badge"
```

---

### Task 8: Settings, config default, and `maxSlots` 5

**Files:**
- Modify: `server/config.ts:130-135` (defaults)
- Modify: `client/src/lib/components/SettingsModal.svelte` (the `servers` tab, ~:455-500)
- Modify: `docs/config.md`
- Test: `test/config.test.ts` (extend)

**Interfaces:**
- Consumes: `ConcurrencyConfig.slotPolicy` (Task 2)
- Produces: shipped defaults `maxSlots: 5`, `slotPolicy: 'free-ports'`

- [ ] **Step 1: Write the failing test**

Append to `test/config.test.ts`:

```ts
test('defaults ship five slots and the free-ports policy', () => {
  const c = defaults({});
  assert.equal(c.concurrency.maxSlots, 5);
  assert.equal(c.concurrency.slotPolicy, 'free-ports');
});
```

Match the existing import and `defaults()` call style already in that file.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/config.test.ts`
Expected: FAIL — `maxSlots` is 3, `slotPolicy` undefined

- [ ] **Step 3: Update the defaults**

`server/config.ts`:

```ts
    concurrency: {
      enabled: true,
      offsetStep: 100,
      maxSlots: 5,
      slotPolicy: 'free-ports',
      repos: {},
    },
```

- [ ] **Step 4: Verify the collision validator stays quiet**

Run: `node --test test/config.test.ts test/concurrency.test.ts`
Expected: PASS, and no `maxSlots`/port-family warning on stderr. The validator flags families whose base ports differ by a multiple of `offsetStep` within `(maxSlots-1)*offsetStep`; at 5 slots that window is 400, and the real `accept-blue` bases (1231/1232/1233/1239/1999) have no such pair.

- [ ] **Step 5: Add the settings controls**

In the `servers` tab of `SettingsModal.svelte`, following the field markup already in that tab: two radios bound to `concurrency.slotPolicy` — *Lowest free slot* (`lowest`) and *Lowest slot whose ports are actually free* (`free-ports`) — and a number input for `concurrency.maxSlots`. Copy from the mockup's section 05. Persist through whatever save path that tab already uses; do not add a new one.

- [ ] **Step 6: Document it**

In `docs/config.md`, extend the `concurrency` section with `slotPolicy` (both values, the default, and why `free-ports` exists) and the new `maxSlots` default.

- [ ] **Step 7: Run everything and commit**

```bash
npm test
npm run build
git add server/config.ts client/src docs/config.md test/config.test.ts
git commit -m "Five slots by default, and a slot policy that skips bound ports"
```

---

### Task 9: Full verification

**Files:** none

- [ ] **Step 1: Full gate**

Run: `npm test` (typecheck + server suite + client suite)
Expected: PASS, no skips

- [ ] **Step 2: Lint and format**

```bash
npm run lint
npm run format:check
```
Expected: clean. Fix with `npm run format` if not.

- [ ] **Step 3: Confirm slot 0 is unchanged for a single feature**

Run: `node --test test/concurrency-wiring.test.ts test/no-regression.test.ts`
Expected: PASS — a start with no slot must still behave byte-for-byte as before.

- [ ] **Step 4: Real-app check**

Start the daemon from this worktree on a spare port, open it, and confirm against the live fleet: the caret lists five slots; slot 1 shows `held by iso-mfa-totp`; slot 0 shows `blocked` for a feature containing `accept-blue` and `free` for `su-mfa-cleanup` as it stands. Do not start or stop the user's running servers to test this — read-only observation of the menu is the check.

- [ ] **Step 5: Final commit if anything moved**

```bash
git add -A
git commit -m "Slot picker: verification pass"
```

---

## Notes for the executor

- The user's own `~/.config/worktree-studio/config.json` still says `maxSlots: 3`. Shipped defaults do not rewrite an existing config. Changing the live value is the user's call — surface it at the end, do not edit their config file as part of a task.
- `test/no-duplication.test.ts` guards against copy-pasted route logic. If it fails after Task 5, the fix is to share the slot-verification helper between `/group/start` and `/group/slot`, not to weaken the test.
