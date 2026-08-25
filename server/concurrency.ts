// Pure, side-effect-free helpers for running 2–3 features concurrently.
// Each feature gets a "slot" (0,1,2…). Slot n offsets every dev-server port by
// n*offsetStep and sets each per-slot env value (e.g. redis__db) to n. Slot 0 ==
// today's defaults, so a single feature is byte-for-byte unchanged.

import type { RepoConcurrency } from './types.ts';
// portRefRe/rewriteSiblingPort/rewriteAllSiblingPorts live in slot-rewrite.ts so the
// Vite wrapper can apply the identical rewrite from inside the dev server's process.
// Re-exported below: this module stays the import site everything already uses.
import { portRefRe, rewriteSiblingPort, rewriteAllSiblingPorts } from './slot-rewrite.ts';

// deriveEnv(repoConc, slot, offsetStep) → { env, ports }
//   portEnv keys become env[KEY] = basePort + slot*offsetStep (and a port);
//   slotEnv keys become env[KEY] = slot (e.g. redis__db — an index, not a port);
//   scheduler.env becomes on/off depending on whether this slot owns the job scheduler.
function deriveEnv(
  repoConc: RepoConcurrency | null | undefined,
  slot: number,
  offsetStep: number,
): { env: Record<string, string>; ports: number[] } {
  const env: Record<string, string> = {};
  const ports: number[] = [];
  const portEnv = repoConc?.portEnv || {};
  const slotEnv = repoConc?.slotEnv || [];
  for (const key of Object.keys(portEnv)) {
    const port = portEnv[key] + slot * offsetStep;
    env[key] = String(port);
    ports.push(port);
  }
  for (const key of slotEnv) env[key] = String(slot);
  /*
   * Exactly one slot may run the job scheduler, and every other slot is told to stand down.
   *
   * MANUAL.md has always stated this as a hard rule ("the job scheduler must only ever run
   * in one stack") and nothing in code knew it: slots are handed out and reclaimed by
   * allocSlot/reconcileSlots with no notion of a privileged one, so two features each ran a
   * backend that believed it was the scheduler. Duplicate scheduled jobs do not fail — they
   * succeed, twice — so the report is a doubled charge or a doubled email, hours later, with
   * nothing in any log calling it an error.
   *
   * Both halves are written, not just the owner's. Setting only `on` would leave slot 1's
   * backend on whatever its own config defaults to, which for a repo whose default is "yes,
   * run jobs" is the entire bug. The stand-down is the half that enforces the rule.
   *
   * Rides deriveEnv because this is the same kind of fact as `redis__db`: a value that
   * depends on nothing but the slot. A second mechanism would be a second place for a
   * launch path to forget to consult.
   *
   * Opt-in: no `scheduler` key → no variable set → today's behavior, byte for byte.
   */
  const sched = repoConc?.scheduler;
  if (sched?.env) {
    const owner = sched.slot ?? 0;
    env[sched.env] = slot === owner ? (sched.on ?? 'true') : (sched.off ?? 'false');
  }
  return { env, ports };
}

// allocSlot(usedSlots, maxSlots) → lowest integer in [0,maxSlots) not in
// usedSlots, else null (all slots busy). usedSlots may be a Set or array.
function allocSlot(usedSlots: Set<number> | number[] | null | undefined, maxSlots: number): number | null {
  const used = usedSlots instanceof Set ? usedSlots : new Set(usedSlots || []);
  for (let i = 0; i < maxSlots; i++) if (!used.has(i)) return i;
  return null;
}

// siblingPortsIn(text, siblingPortEnv, offsetStep, maxSlots) → the sibling-repo ports
// `text` actually references right now, sorted ascending. The inverse of
// rewriteAllSiblingPorts: it enumerates the exact same port families (each base, plus
// base + k*offsetStep for k in 0..maxSlots-1) and reports which of them are present
// instead of moving them.
//
// This is the half that never existed. applyConfigPatch has always been write-only —
// nothing read the file back — so a config could say `localhost:1439` while the
// process on 1439 belonged to a different feature's branch, and every surface in the
// app reported green. Reading it back is the only way to know.
//   - Pure. Ports outside the families are invisible here by construction: a number
//     that is not `base + k*step` is not a port this system ever wrote.
function siblingPortsIn(
  text: string,
  siblingPortEnv: Record<string, number> | null | undefined,
  offsetStep: number,
  maxSlots: number,
): number[] {
  const src = String(text == null ? '' : text);
  const found = new Set<number>();
  for (const base of Object.values(siblingPortEnv || {})) {
    for (let k = 0; k < maxSlots; k++) {
      const port = base + k * offsetStep;
      // A fresh regex per probe: portRefRe is /g, and a shared /g regex carries
      // lastIndex between .test() calls — the same port would match, then miss.
      if (portRefRe(port).test(src)) found.add(port);
    }
  }
  return [...found].sort((a, b) => a - b);
}

export { deriveEnv, allocSlot, rewriteSiblingPort, rewriteAllSiblingPorts, siblingPortsIn };
