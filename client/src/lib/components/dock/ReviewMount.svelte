<script>
  /*
   * MOUNT POINT — the Changes / review panel.
   *
   * The review panel (commits, side-by-side diff, hunk staging) is built separately and
   * lives in `$lib/components/review/`. The shell must not import its internals while
   * it is in flight, so the wiring is isolated to this one file: at integration, delete
   * the placeholder markup below and replace it with
   *
   *     import Changes from '$lib/components/review/Changes.svelte';
   *     …
   *     <Changes {session} />
   *
   * Contract this mount guarantees:
   *  - It is rendered only while `ui.dockView === 'changes'`, and only for a session
   *    with a `worktreePath` (the ✎ Changes tab is hidden otherwise).
   *  - `session` is the live, stitched session object — it updates in place as frames
   *    arrive; the panel is not remounted on a state change.
   *  - The panel owns the full remaining height of the dock, above the server bar.
   *  - `onchangescount` lets the panel push the uncommitted-file count back up so the
   *    tab badge stays in sync without the shell fetching commits a second time.
   */
  // `onchangescount` is unused by the placeholder and consumed by the real panel; it is
  // declared here so the prop contract lives with the mount rather than in a comment.
  let { session, onchangescount } = $props();
  const label = $derived(session?.title ?? '');
</script>

<div class="panel-mount">
  <div class="mount-note">
    <b>✎ Changes</b>
    <span>The review panel mounts here{label ? ` for “${label}”` : ''}.</span>
  </div>
</div>

<style>
  .panel-mount { flex:1; min-height:0; display:flex; background:var(--bg); }
  .mount-note { margin:auto; text-align:center; color:var(--faint); font-family:var(--mono); font-size:12px; display:flex; flex-direction:column; gap:8px; }
  .mount-note b { color:var(--muted); font-size:13px; }
</style>
