// Pure, side-effect-free helpers for running 2–3 features concurrently.
// Each feature gets a "slot" (0,1,2…). Slot n offsets every dev-server port by
// n*offsetStep and sets each per-slot env value (e.g. redis__db) to n. Slot 0 ==
// today's defaults, so a single feature is byte-for-byte unchanged.

import type { RepoConcurrency } from './types.ts';

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

// rewriteSiblingPort(text, basePort, offsetStep, maxSlots, newPort) → `text` with
// every `localhost:<basePort + k*offsetStep>` (for k in 0..maxSlots-1) rewritten to
// `localhost:<newPort>`. Used to re-point a per-worktree FE config (gitignored
// `src/config.ts`) at the sibling backend's port for its slot.
//   - Only touches ports in this family (base, base+step, …); everything else is left
//     byte-for-byte — including other numbers and unrelated `localhost:<port>`s.
//   - The `localhost:` anchor + a trailing non-digit guard mean `localhost:1239` never
//     matches inside `localhost:12390`.
//   - Idempotent: re-running yields the same result (newPort is itself in the family
//     and is skipped), so it can also re-target an already-shifted config.
function rewriteSiblingPort(
  text: string,
  basePort: number,
  offsetStep: number,
  maxSlots: number,
  newPort: number,
): string {
  let out = String(text == null ? '' : text);
  for (let k = 0; k < maxSlots; k++) {
    const port = basePort + k * offsetStep;
    if (port === newPort) continue; // leave the target port as-is (idempotency)
    out = out.replace(portRefRe(port), `$1:${newPort}`);
  }
  return out;
}

// What a reference to a backend port LOOKS like in an FE config, spelled once.
//
// Match either host form and preserve it (localhost stays localhost, 127.0.0.1 stays
// 127.0.0.1); the trailing non-digit guard is what stops `1239` matching inside `12390`.
//
// One function because the writer and the reader must not be able to disagree:
// rewriteSiblingPort REWRITES what this matches and siblingPortsIn READS BACK what
// that wrote. A second spelling of the pattern is a second definition of "points at
// this backend", and the two would drift the first time either side learned a new
// host form — leaving the reader quietly blind to references the writer still edits.
function portRefRe(port: number): RegExp {
  return new RegExp(`(localhost|127\\.0\\.0\\.1):${port}(?![0-9])`, 'g');
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

// rewriteAllSiblingPorts(text, siblingPortEnv, offsetStep, maxSlots, slot) → `text`
// with EVERY sibling-repo port family shifted to `slot`. For each base port in
// Object.values(siblingPortEnv), it rewrites every `localhost:<base + k*offsetStep>`
// (k in 0..maxSlots-1) to `localhost:<base + slot*offsetStep>` (one rewriteSiblingPort
// pass per base). Used for FE configs that reference MULTIPLE ports of one backend —
// a feature at slot n runs one backend instance serving
// all of them at +n*offsetStep, so all of those refs must move together.
//   - Pure, idempotent, port-family-safe (inherits rewriteSiblingPort's `(?![0-9])` guard).
//   - Slot 0 is a no-op (every base → itself).
function rewriteAllSiblingPorts(
  text: string,
  siblingPortEnv: Record<string, number> | null | undefined,
  offsetStep: number,
  maxSlots: number,
  slot: number,
): string {
  let out = String(text == null ? '' : text);
  for (const base of Object.values(siblingPortEnv || {})) {
    out = rewriteSiblingPort(out, base, offsetStep, maxSlots, base + slot * offsetStep);
  }
  return out;
}

export { deriveEnv, allocSlot, rewriteSiblingPort, rewriteAllSiblingPorts, siblingPortsIn };
