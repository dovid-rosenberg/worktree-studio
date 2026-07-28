<script lang="ts">
  // SearchPanel in the app's command-palette chrome.
  //
  // The palette is where transcript search will most likely be mounted, and an overlay
  // has obligations a panel doesn't: focus cannot escape it while it is open, Escape
  // closes it, and focus goes back where it came from afterwards. `trapFocus` does all
  // three — the restore-on-destroy is what makes closing the palette land the caret
  // back in the terminal rather than on <body>.
  import { trapFocus } from '$lib/actions/trapFocus.js';
  import SearchPanel from './SearchPanel.svelte';

  /**
   * @type {{
   *   open?: boolean,
   *   sessionId?: string|null,
   *   sessions?: import('./types.js').StateSession[]|null,
   *   onopen?: (hit: import('./types.js').Hit) => void,
   *   onclose?: () => void,
   * }}
   */
  let { open = false, sessionId = null, sessions = null, onopen = () => {}, onclose = () => {} } = $props();

  // The panel consumes Escape itself whenever it has something to undo — clearing a
  // non-empty query, or stepping out of the results list — and stops propagation when
  // it does. So anything reaching here is an Escape nobody wanted, which means close.
  /** @param {KeyboardEvent} e */
  function onDialogKey(e: any) {
    if (e.key === 'Escape') { e.preventDefault(); onclose(); }
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <div class="modal-backdrop top" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) onclose(); }}>
    <div
      class="palette"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label="Search transcripts"
      use:trapFocus
      onkeydown={onDialogKey}
    >
      <div class="fill">
        <SearchPanel {sessionId} {sessions} {onopen} onclose={onclose} />
      </div>
    </div>
  </div>
{/if}

<style>
  /* Ported from public/style.css's .modal-backdrop.top / .palette — same geometry, so
     the two UIs are indistinguishable while both are running. */
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0, 0, 0, .45);
    display: grid; place-items: start center; padding: 20px; padding-top: 10vh; z-index: 70;
  }
  .palette {
    width: min(760px, 96vw); max-height: 78vh;
    display: flex; flex-direction: column;
    background: var(--panel); border: 1px solid var(--border-strong);
    border-radius: 14px; box-shadow: var(--shadow); overflow: hidden;
  }
  /* SearchPanel is a flex column that wants to fill its box; give it one. */
  .fill { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  .fill :global(> section) { flex: 1; min-height: 0; }
</style>
