<script lang="ts">
  /*
   * The shared overlay chrome: backdrop, click-outside-to-close, focus trap, focus
   * restore. Every overlay in the app (intake, settings, dialogs, palette) is this
   * component plus content, so the accessibility behaviour is written once.
   *
   * Escape is NOT handled here — the global handler owns it, because it has to close
   * the *topmost* overlay and only it knows what else is open.
   */
  import { trapFocus } from '$lib/actions/trapFocus.js';

  let {
    /** Extra classes on the backdrop, e.g. `top` for the palette's top alignment. */
    backdropClass = '',
    /** Extra classes on the panel. */
    panelClass = '',
    /** aria-label for the dialog. */
    label = '',
    /** Called when the backdrop itself is clicked. */
    onclose,
    children,
  } = $props();

  /** @param {MouseEvent} e */
  function onBackdrop(e: any) {
    // Only a click on the backdrop itself — not one that bubbled out of the panel.
    if (e.target === e.currentTarget) onclose?.();
  }
</script>

<!-- The backdrop is a click target for dismissal, not a control: keyboard users get
     Escape (global) and the trap keeps them inside the panel, so it needs no role. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="modal-backdrop {backdropClass}" onclick={onBackdrop}>
  <div class="modal {panelClass}" role="dialog" aria-modal="true" aria-label={label} use:trapFocus>
    {@render children?.()}
  </div>
</div>

<style>
  .modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.45); display:grid; place-items:center; z-index:50; padding:20px; }
  /* The palette sits above everything and hangs from the top rather than centring. */
  .modal-backdrop:global(.top) { place-items:start center; padding-top:12vh; z-index:70; }
  .modal { width:min(560px,96vw); background:var(--panel); border:1px solid var(--border-strong); border-radius:14px; box-shadow:var(--shadow); overflow:hidden; max-height:92vh; display:flex; flex-direction:column; }
  .modal:global(.dlg) { width:min(460px,94vw); }
  .modal:global(.palette) { width:min(600px,96vw); }
</style>
