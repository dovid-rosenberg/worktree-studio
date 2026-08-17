<script lang="ts">
/*
 * Insights: the dock's one fleet-wide destination (⌘\).
 *
 * WHAT IS LEFT HERE, AND WHY IT IS THIN. This view used to be the cost overview —
 * a hero spend figure, a per-feature cost ranking and a per-session token mix. All
 * of that derived from a hand-maintained price table that went stale on its own and
 * produced a dollar ESTIMATE nobody was billed for, so it was removed. Search, the
 * other thing that lived under this word, is its own overlay now: ⌘⇧F, or "Search
 * transcripts" in the palette and the ⋮ menu.
 *
 * What genuinely remains fleet-wide and true is the state of the transcript index
 * that search runs on — which backend, how much is indexed, and a way to rebuild it.
 * That is what this renders. Whether Insights should keep its own dock view for that
 * is an open product question, deliberately not answered here.
 */
import IndexStatus from '$lib/components/insights/IndexStatus.svelte';
import { transcriptStatus, reindex } from '$lib/components/insights/api.js';
import type { TranscriptStatus } from '$lib/components/insights/types';
import { errMessage } from '$lib/errmsg.js';

let status: TranscriptStatus | null = $state(null);
let error: string | null = $state(null);
let busy = $state(false);

async function load() {
  try {
    status = await transcriptStatus();
    error = null;
  } catch (e) {
    error = errMessage(e);
  }
}

// Mount only: load() reads nothing reactive in its synchronous prologue, so this
// effect has no dependencies and cannot re-run.
$effect(() => {
  load();
});

async function rebuild(o: { session?: string | null; full?: boolean }) {
  busy = true;
  try {
    await reindex(o);
  } catch (e) {
    error = errMessage(e);
  } finally {
    busy = false;
    await load();
  }
}
</script>

<div class="fleetinsights">
  <section class="ix-view" aria-label="Transcript index">
    <h3>Transcript index</h3>
    <p class="sub">What ⌘⇧F searches over.</p>
    <IndexStatus {status} {busy} {error} onreindex={rebuild} />
    <IndexStatus {status} compact {busy} onreindex={rebuild} />
  </section>
</div>

<style>
  /* One scroller for the whole view. */
  .fleetinsights { flex: 1; min-height: 0; overflow-y: auto; background: var(--bg); }
  .ix-view { display: flex; flex-direction: column; gap: 12px; padding: 18px; }
  .ix-view h3 { margin: 0; font-size: 14px; font-weight: 650; }
  .ix-view .sub { margin: 0; font-size: 12px; color: var(--muted); }
</style>
