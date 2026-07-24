'use strict';
// Pure, side-effect-free helpers for running 2–3 features concurrently.
// Each feature gets a "slot" (0,1,2…). Slot n offsets every dev-server port by
// n*offsetStep and sets each per-slot env value (e.g. redis__db) to n. Slot 0 ==
// today's defaults, so a single feature is byte-for-byte unchanged.

// deriveEnv(repoConc, slot, offsetStep) → { env, ports }
//   repoConc: { portEnv: { KEY: basePort, … }, slotEnv: [KEY, …] }
//   portEnv keys become env[KEY] = basePort + slot*offsetStep (and a port);
//   slotEnv keys become env[KEY] = slot (e.g. redis__db — an index, not a port).
function deriveEnv(repoConc, slot, offsetStep) {
  const env = {};
  const ports = [];
  const portEnv = (repoConc && repoConc.portEnv) || {};
  const slotEnv = (repoConc && repoConc.slotEnv) || [];
  for (const key of Object.keys(portEnv)) {
    const port = portEnv[key] + slot * offsetStep;
    env[key] = String(port);
    ports.push(port);
  }
  for (const key of slotEnv) env[key] = String(slot);
  return { env, ports };
}

// allocSlot(usedSlots, maxSlots) → lowest integer in [0,maxSlots) not in
// usedSlots, else null (all slots busy). usedSlots may be a Set or array.
function allocSlot(usedSlots, maxSlots) {
  const used = usedSlots instanceof Set ? usedSlots : new Set(usedSlots || []);
  for (let i = 0; i < maxSlots; i++) if (!used.has(i)) return i;
  return null;
}

// rewriteSiblingPort(text, basePort, offsetStep, maxSlots, newPort) → `text` with
// every `localhost:<basePort + k*offsetStep>` (for k in 0..maxSlots-1) rewritten to
// `localhost:<newPort>`. Used to re-point a per-worktree FE config (gitignored
// `src/config.js`) at the accept-blue merchant port for its slot.
//   - Only touches ports in this family (base, base+step, …); everything else is left
//     byte-for-byte — including other numbers and unrelated `localhost:<port>`s.
//   - The `localhost:` anchor + a trailing non-digit guard mean `localhost:1239` never
//     matches inside `localhost:12390`.
//   - Idempotent: re-running yields the same result (newPort is itself in the family
//     and is skipped), so it can also re-target an already-shifted config.
function rewriteSiblingPort(text, basePort, offsetStep, maxSlots, newPort) {
  let out = String(text == null ? '' : text);
  for (let k = 0; k < maxSlots; k++) {
    const port = basePort + k * offsetStep;
    if (port === newPort) continue; // leave the target port as-is (idempotency)
    const re = new RegExp(`localhost:${port}(?![0-9])`, 'g');
    out = out.replace(re, `localhost:${newPort}`);
  }
  return out;
}

module.exports = { deriveEnv, allocSlot, rewriteSiblingPort };
