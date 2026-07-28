'use strict';
// Single-flight for the repo rescan — with a QUEUE, not a drop.
//
// server.js guarded the scan with `if (scanning) return;`, which discards the
// request outright. Most droppers self-heal, because the mutation the caller had
// just made also wrote something under `.git/worktrees/…` and server/watch.js
// fires on that a moment later. POST /api/settings does not: changing `baseDirs`
// sets rescanNeeded, `await rescan()` returned instantly whenever a background
// scan happened to be in flight, and nothing on the filesystem is ever going to
// signal a directory that was never scanned in the first place. The new base dirs
// went unscanned, no watchers were armed on them, and broadcastTopology() was
// skipped — so the user saw "settings saved" next to a stale repo list until the
// safety-net timer came round: 60 s with the dashboard open, five minutes without.
//
// Two properties the callers actually need, and the second is the one that was
// missing:
//   * one scan at a time;
//   * a caller's await resolves only after a scan that STARTED AFTER their call.
//     An already-running scan may have read the disk before their change landed,
//     so joining it would answer with a view that predates them.
// Everyone who asks mid-scan therefore shares ONE follow-up and waits for it —
// the same collapse-into-a-single-rerun that server/watch.js already does for its
// own triggers.
function createRescan(scan) {
  let inFlight = null; // the scan running right now
  let followUp = null; // the single queued re-run, shared by every mid-scan caller

  return function rescan() {
    if (inFlight) {
      // .catch() first for two reasons: a caller queued behind a scan that FAILED
      // still wants their own scan to run, and without it `followUp` would never be
      // reset — leaving every later mid-scan caller holding a stale rejected promise.
      if (!followUp) followUp = inFlight.catch(() => {}).then(() => { followUp = null; return rescan(); });
      return followUp;
    }
    inFlight = Promise.resolve().then(scan).finally(() => { inFlight = null; });
    return inFlight;
  };
}

module.exports = { createRescan };
