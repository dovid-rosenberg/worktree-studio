# Choosing and changing concurrency slots

**Status:** design approved, ready for an implementation plan
**Date:** 2026-08-17
**Mockup:** https://claude.ai/code/artifact/1f2b112c-7177-4f16-934f-31c7ebd5409b

## Why

A feature's concurrency slot is allocated automatically and cannot be seen before the
fact or changed after it. `allocSlotFor` hands out the lowest slot not already in its own
`slots` map, and that is the whole conversation. Two consequences motivated this work:

- **The allocator ignores reality.** It never checks whether a slot's ports are actually
  free. A process Studio does not track — one started before the slot map existed, or from
  a terminal — can sit on slot 0's ports while slot 0 is handed to a new feature. The
  launch then fails on `start()`'s port pre-check with a message naming a pid, which is
  correct but arrives after you have already committed to starting.
- **You cannot say where something should run.** Wanting a particular feature on a
  particular slot, or wanting to move a running one out of the way, has no expression in
  the UI at all.

This adds three things: a slot picker at start, a move operation for a running feature,
and a default-slot policy that skips slots whose ports are occupied.

## Decisions

These are settled and the design does not revisit them.

1. **Slots stay per-feature.** A slot is one per feature, shared by its member repos.
   Per-repo slots would break the sibling config patch that points a frontend at its
   backend's ports.
2. **Pooled when stopped.** A stopped feature's slot returns to the pool immediately, which
   is what `releaseSlotIfIdle` already does. No reservations.
3. **No pinning.** A pin was only meaningful in a design where it reserved the slot. Under
   pooling it degrades to a preference that silently fails to apply, which is worse than
   no affordance. The picker covers the deliberate case in one extra click.
   *Revisit only if something outside Studio — an ngrok tunnel, a registered webhook —
   needs a port to stay stable across sessions.*
4. **Studio never stops a process it did not start.** A slot blocked by an untracked pid is
   disabled in the picker and names the pid. Clearing it is the user's job.
5. **`maxSlots` 3 → 5.**
6. **Default policy: lowest slot whose ports are actually free.**

## Occupancy is per feature, not global

The central correctness point, and the one that shapes the API.

A slot has no single occupancy state. `start()` pre-checks only the ports that *this
repo* derives for the slot, so whether a slot is usable depends on which repos the
feature has. Slot 0 today, judged twice:

| Feature | Member repos | Ports needed on slot 0 | Verdict |
|---|---|---|---|
| `su-mfa-cleanup` (as it exists) | `ab-su` | 8000 | free |
| `su-mfa-cleanup` + `accept-blue` | `accept-blue`, `ab-su` | 1231 1232 1233 1239 1999 · 8000 | blocked |

This is live, not hypothetical: the SU frontend is running on slot 0 port 8000 right now
while the same slot cannot host a backend, because an untracked `node app.js` from the
`recurring-deleted-pm` worktree holds 1231–1999. A global occupancy model would have
greyed out the only start that currently works.

Every occupancy answer is therefore computed for a named feature.

### The three states

| State | Meaning | Pickable |
|---|---|---|
| `free` | No feature holds the slot, and every port this feature would derive on it is unbound | yes |
| `held` | Another feature holds the slot in `servers.json` | no |
| `blocked` | No feature holds the slot, but at least one port this feature needs is bound by an untracked process | no |

`held` and `blocked` are distinct because their remedies differ: stop the other feature
versus deal with a stray process yourself. `blocked` carries the offending port and pid.

## Server design

### New: occupancy computation

One new method on `Servers`, because every surface needs the same answer:

```
slotReport(feature: string): Promise<SlotReport[]>
```

`SlotReport` is `{ slot, state: 'free'|'held'|'blocked'|'current', ports: Record<repo, number[]>, heldBy?: string, blockedBy?: { port, pid } }`,
one entry per slot `0..maxSlots-1`.

For each slot it derives that feature's member repos' ports via the existing `deriveEnv`,
then resolves state:

- the feature's own current slot → `current`
- another feature in `this.slots` holds it → `held` with that feature's name
- any derived port answers `portPid()` → `blocked` with the first such port and pid
- otherwise `free`

`portPid` is already the primitive `start()` uses, so the picker and the pre-check agree
by construction rather than by two implementations staying in step. Reads only; it
allocates nothing.

### Changed: `allocSlotFor` gains a policy and an explicit request

```
allocSlotFor(feature: string, opts?: { requested?: number }): SlotAllocation
```

- A held slot is returned unchanged, as today.
- `requested` is honored when its state for this feature is `free`, and refused with a
  specific error otherwise — `slot 1 is held by iso-mfa-totp`, `slot 0: port 1231 is in
  use by pid 54549`. It is never silently downgraded to a different slot; the user asked
  for a slot and gets either it or a reason.
- With no `requested`, the default policy picks the lowest slot whose state is `free`,
  falling back to the existing "lowest not in the slots map" only when every slot is
  blocked, so a machine full of stray processes still starts somewhere and fails with
  the existing port message rather than refusing to try.

Because this consults live port state it becomes async. `allocSlotFor` is called from
`startAll`, `/servers/restart` and `/group/restart`, all already async.

### Changed: `startAll` threads the request through

```
startAll(targets, opts?: { slot?: number })
```

`startAll` is the single choke point all three start routes share, and it already
allocates every slot before launching anything. The requested slot rides through to
`allocSlotFor`; the all-slots-first ordering is unchanged, so a refused request still
spawns nothing.

### New: the move operation

```
POST /api/v1/group/slot   { group: string, slot: number }
```

A move is stop → re-patch → start. Ports come from environment variables read at launch
and the frontend config patch is written to the worktree before spawn, so nothing can
slide across without a bounce.

Sequence:

1. Resolve the feature. 404 if unknown.
2. `slotReport(feature)`; refuse with 409 unless the target is `free`. **This happens
   before anything is stopped** — a half-moved feature, backend on the new slot and
   frontend dead, is worse than no move.
3. Stop every running member (`servers.stop`, existing port sweep).
4. `releaseSlot(feature)`, then `allocSlotFor(feature, { requested: slot })`.
5. `startAll` the members that were running.
6. `refreshRunning`, broadcast, and answer the standard `startReport.report` shape.

The gap between 2 and 5 is a real race — another feature could take the target slot in
between. Step 4's allocation is the authority: if it fails, the move answers 409 having
already stopped the feature, and the toast says so plainly. Accepted rather than locked
against; the window is small and the user is the only actor.

Only running members are restarted. A member that was stopped stays stopped and comes up
on the feature's new slot whenever it is next started.

### Config

`maxSlots: 3 → 5` in `~/.config/worktree-studio/config.json`, plus a new
`concurrency.slotPolicy: 'free-ports' | 'lowest'`, defaulting to `'free-ports'`.
`'lowest'` preserves today's behavior for anyone who wants slot assignment to be
independent of what is listening.

New slots derive: `accept-blue` 1531·1532·1533·1539·2299 and 1631·1632·1633·1639·2399,
`merchant-v3` 3330/3430, `ab-iso-fe` 9300/9400, `ab-su` 8300/8400, `redis__db` 3/4.
Nothing collides within the set. 8300 and 8400 are commonly claimed by other tools and
should be confirmed clear on the machine before the bump lands.

### State payload

`state.ts` already publishes `feature.slot`. It gains nothing: the picker fetches
`slotReport` on open rather than riding the topology frame, because occupancy depends on
live port state and would otherwise be recomputed for every feature several times a
second.

```
GET /api/v1/group/:name/slots  →  SlotReport[]
```

## Client design

### The start picker

The action bar's feature branch gains a split button: `▶ Start` keeps its exact current
behavior — one click, default slot, no new decision — and a caret opens the picker.

The menu fetches `GET /group/:name/slots` on open. Each row shows the slot number, the
ports that feature would derive there, and its state. `free` rows are buttons; `held` and
`blocked` rows are `disabled` and carry their reason (`held by iso-mfa-totp`,
`accept-blue 1231 held by pid 54549`). Choosing a row posts `/group/start` with `slot`.

`runStack(name, slot?)` in `ops.svelte.ts` grows the optional argument. Its existing
`needsConfirm` stop-and-switch path is untouched and still applies to a chosen slot.

### The move control

The slot badge in `FeaturePane.svelte` and `FeatureCard.svelte` becomes the affordance —
the element that displays the slot is the element that changes it, so no new button
appears anywhere. It opens the same menu component, sourced from the same endpoint, with
the feature's current slot marked `current` and disabled.

Choosing a target opens a confirm that names the mechanism rather than implying a slide:

> **Move "iso-mfa-totp" to slot 2?**
> Both dev servers restart. Your session, terminal, and working tree are untouched.
> `accept-blue` 1331 1332 1333 1339 2099 → 1431 1432 1433 1439 2199
> `ab-iso-fe` 9100 → 9200 · `redis__db` 1 → 2
> `ab-iso-fe/src/config/config.js` is rewritten to point at the backend's new ports.

On confirm it posts `/group/slot` and reports through the existing `startResult`
summarizer, so a partial outcome reads honestly.

### Settings

`SettingsModal.svelte` has no concurrency section; its sidebar runs repos / dev servers /
editors / connections / notifications. These controls belong in the existing **Dev
servers** tab rather than a new one — slot policy is a property of how dev servers are
launched, and a sixth tab holding two fields would not earn its place. The tab gains the
slot policy as two radios (*lowest free slot* / *lowest slot whose ports are actually
free*) and a `maxSlots` number field.

### Shared component

One `SlotMenu.svelte` serves both entry points. It takes a feature name and a mode
(`start` | `move`), fetches the report, and emits the chosen slot. The two callers differ
only in their heading and what they do with the answer.

## Error handling

| Situation | Behavior |
|---|---|
| Requested slot became `held` between fetch and post | 409, specific message naming the holder; nothing started |
| Requested slot became `blocked` | 409 naming port and pid; nothing started |
| Every slot blocked, no explicit request | Falls back to lowest unheld slot; launch proceeds and fails on the existing port pre-check |
| Move loses the race after stopping | 409; feature left stopped, toast says the slot was taken and the feature is down |
| A member fails to start after a successful move | Existing `startReport` partial reporting — `started 1/2` with the failing repo's reason |
| `slot` out of range or not a number | 400 |

## Testing

Unit, against `test/*.test.ts` with `node --test`:

- `slotReport` returns `free` for a slot whose *other* repos' ports are bound but whose
  member repos' ports are not — the `su-mfa-cleanup` case, and the one a global model
  gets wrong.
- `slotReport` distinguishes `held` from `blocked`, and marks the feature's own slot
  `current`.
- `allocSlotFor` honors a free `requested`; refuses a held or blocked one with a message
  naming the holder or the pid; never silently substitutes another slot.
- Default policy skips a blocked slot and takes the next free one.
- Default policy falls back rather than erroring when every slot is blocked.
- `startAll` allocates all slots before launching, and a refused request spawns nothing.

Route level:

- `/group/slot` refuses an unavailable target **without stopping anything** — asserted by
  observing that the members are still running after the 409.
- `/group/slot` restarts only members that were running.

Client, with vitest:

- The menu disables `held` and `blocked` rows and renders their reasons.
- `▶ Start` with no slot posts a body without a `slot` key (the default path is not
  accidentally pinned to 0).

## Out of scope

- Per-repo slots (decision 1).
- Pinning or reserving slots (decisions 2, 3).
- Stopping or killing untracked processes (decision 4).
- Changing how `offsetStep` or `portEnv` work.
- Reclaiming a slot for a discovered-but-untracked server. Studio's existing behavior —
  the server runs, shows as running, holds no slot — is unchanged. The `blocked` state
  exists precisely to make that situation legible instead of fixing it implicitly.
