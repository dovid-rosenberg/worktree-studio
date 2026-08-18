<script lang="ts">
/*
 * The application shell's outermost frame.
 *
 * It owns exactly four things, all of which outlive any single route:
 *   - the theme,
 *   - the SSE connection (one per document, torn down on destroy so HMR cannot leak
 *     a second EventSource),
 *   - the global keyboard handler,
 *   - the overlays: toasts, dialogs, the palette, and the two modals.
 *
 * Everything visible lives in +page.svelte.
 */
import '../app.css';
import { initTheme } from '$lib/theme.svelte.js';
import { connectStream } from '$lib/stores/world.svelte.js';
import { notify } from '$lib/stores/notify.svelte.js';
import { handleShortcut } from '$lib/shortcuts.svelte.js';
import { overlays } from '$lib/stores/overlays.svelte.js';
import Toasts from '$lib/components/Toasts.svelte';
import DialogHost from '$lib/components/DialogHost.svelte';
import Palette from '$lib/components/Palette.svelte';
import SearchOverlay from '$lib/components/SearchOverlay.svelte';
import IntakeModal from '$lib/components/IntakeModal.svelte';
import SettingsModal from '$lib/components/SettingsModal.svelte';

let { children } = $props();

// Reconciles the store with whatever the pre-paint script in app.html already put on
// <html>, so the toggle's first click always flips away from what the user is seeing.
initTheme();

$effect(() => {
  notify.loadPrefs();
  // The frame is handed to the notifier BEFORE it is swapped into the store — a
  // transition can only be detected against the state that is still current.
  return connectStream({ onSessionFrame: (f) => notify.onSessionFrame(f) });
});

// `● (n) ` in front of the tab title, so a background tab still shows how many
// sessions are waiting. Reactive rather than imperative, so it can never go stale.
const title = $derived(
  notify.waitingCount > 0 ? `● (${notify.waitingCount}) Worktree Studio` : 'Worktree Studio',
);
</script>

<svelte:head><title>{title}</title></svelte:head>
<svelte:window onkeydown={handleShortcut} />

{@render children?.()}

<Toasts />
{#if overlays.intake}<IntakeModal />{/if}
{#if overlays.settings}<SettingsModal />{/if}
{#if overlays.search}<SearchOverlay />{/if}
{#if overlays.palette}<Palette />{/if}
<!-- Last, so a dialog opened from any of the above paints over it. -->
<DialogHost />
