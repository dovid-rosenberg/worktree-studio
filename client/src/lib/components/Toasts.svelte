<script>
  /* Bottom-right toast stack. Keyed by id so an expiring toast doesn't renumber the
     rest and restart their fade. */
  import { toasts } from '$lib/stores/toasts.svelte.js';
</script>

<div class="toast-stack" aria-live="polite" aria-atomic="false">
  {#each toasts.items as t (t.id)}
    <div class="toast" class:err={t.err}>{t.msg}</div>
  {/each}
</div>

<style>
  .toast-stack { position:fixed; bottom:18px; right:18px; z-index:60; display:flex; flex-direction:column; align-items:flex-end; gap:10px; pointer-events:none; }
  .toast { pointer-events:auto; background:var(--panel); border:1px solid var(--border-strong); border-left:3px solid var(--brand); border-radius:10px; padding:11px 14px; box-shadow:var(--shadow); font-size:13px; max-width:360px; }
  .toast.err { border-left-color:#e5484d; }
</style>
