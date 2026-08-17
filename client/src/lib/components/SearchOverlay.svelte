<script lang="ts">
/*
 * Transcript search, as its own overlay.
 *
 * Search has been buried twice. It started as a section inside the session-scoped
 * Insights TAB — reachable only after selecting a session and opening a panel about
 * cost — and when the two Insights were merged it became a drill-down inside fleet
 * Insights, which is the same mistake one level out: something you find only after
 * arriving somewhere else, for a different reason.
 *
 * It is not a view of anything. It is a verb — "find that thing Claude said" — so it
 * behaves like every editor's search-across-everything: ⌘⇧F from wherever you are,
 * over whatever is on screen, gone when you are done.
 *
 * Insights itself no longer exists: the cost estimate it was built around was removed,
 * and the one true thing left in it — the state of the transcript index — followed search
 * in here, where it is read at the moment it matters. See SearchPanel's header.
 *
 * Modal gives it the obligations an overlay has: focus cannot leave it, the backdrop
 * closes it, and focus returns where it came from — which is what lands the caret back
 * in the terminal instead of on <body>.
 */
import Modal from '$lib/components/Modal.svelte';
import SearchPanel from '$lib/components/insights/SearchPanel.svelte';
import { overlays } from '$lib/stores/overlays.svelte.js';
import { ui } from '$lib/stores/ui.svelte.js';
import { world } from '$lib/stores/world.svelte.js';
import type { Hit } from '$lib/components/insights/types';

/*
 * Scoped to the selection when there IS one, and to everything otherwise.
 *
 * This is the one thing the buried version got right and is worth keeping: searching
 * from inside a session usually means searching THAT session. The panel's own scope
 * picker can widen it, which it could not do while it was locked inside a session tab.
 */
const seed = $derived(ui.selectedId);

/** The shell already holds the session list; passing it avoids a second /api/state. */
const sessions = $derived(world.sessions.map((s) => ({ id: s.id, title: s.title, branch: s.branch })));

/** Jumping to a hit means going to its session — and leaving search behind. */
function open(hit: Hit) {
  overlays.closeSearch();
  if (hit.sessionId) ui.goToSession(hit.sessionId);
}
</script>

<Modal
  backdropClass="top"
  panelClass="palette search-panel"
  label="Search transcripts"
  onclose={() => overlays.closeSearch()}
>
  <SearchPanel
    sessionId={seed}
    sessions={sessions as never}
    onopen={open}
    onclose={() => overlays.closeSearch()}
  />
</Modal>

<style>
  /* The palette's chrome, but taller: search results are the content, not a shortlist. */
  :global(.modal-backdrop .palette.search-panel) { max-width: 760px; }
</style>
