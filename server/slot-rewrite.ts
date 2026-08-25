// How a frontend's reference to a sibling backend port is recognised and moved.
//
// Extracted from concurrency.ts so that the Vite wrapper (server/slot-vite-config.mjs)
// can apply the SAME rewrite the daemon reasons about. The wrapper runs inside the dev
// server's own process, not the daemon's, so without a shared module the pattern would
// have to be spelled a second time over there — and the comment on portRefRe below is
// precisely the argument against that.
//
// Pure and side-effect free. concurrency.ts re-exports rewriteSiblingPort and
// rewriteAllSiblingPorts, so existing importers and tests are unaffected by the move.

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

export { portRefRe, rewriteSiblingPort, rewriteAllSiblingPorts };
