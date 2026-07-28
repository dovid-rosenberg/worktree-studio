<script>
  /*
   * MOUNT POINT — the Insights panel (transcript search + cost/token telemetry).
   *
   * Built separately, in `$lib/components/insights/`. At integration, delete the
   * placeholder markup and replace it with
   *
   *     import Insights from '$lib/components/insights/Insights.svelte';
   *     …
   *     <Insights {session} />
   *
   * Contract this mount guarantees:
   *  - Rendered only while `ui.dockView === 'insights'`, for ANY session — a transcript
   *    exists before a worktree does, so this tab is not gated on promotion.
   *  - `session` is the live, stitched session object.
   *  - The panel owns the full remaining height of the dock, above the server bar.
   */
  let { session } = $props();
  const label = $derived(session?.title ?? '');
</script>

<div class="panel-mount">
  <div class="mount-note">
    <b>◔ Insights</b>
    <span>The transcript &amp; telemetry panel mounts here{label ? ` for “${label}”` : ''}.</span>
  </div>
</div>

<style>
  .panel-mount { flex:1; min-height:0; display:flex; background:var(--bg); }
  .mount-note { margin:auto; text-align:center; color:var(--faint); font-family:var(--mono); font-size:12px; display:flex; flex-direction:column; gap:8px; }
  .mount-note b { color:var(--muted); font-size:13px; }
</style>
