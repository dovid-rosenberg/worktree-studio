<script lang="ts">
  import type { Worktree } from '../../../../../server/types';
  /*
   * A dev server running from a repo's MAIN checkout. Not a worktree, so not a feature,
   * so it appears in no other list — this row exists purely so it is openable and
   * stoppable rather than a mystery port. Ported from fleet/MainServerRow.
   *
   * The `repo:port` label is deliberate and matches Fleet's server sections: with several
   * of these up, a bare `:5271` does not say whose it is.
   */
  import { openApp } from '$lib/stores/world.svelte.js';
  import { stopMainServer } from '$lib/ops.svelte.js';

  let { worktree }: { worktree: Worktree } = $props();
</script>

<div class="mcard" role="listitem">
  <div class="l1">
    <span class="dot done"></span>
    <span class="rname">{worktree.repo}</span>
    <span class="src">main</span>
  </div>
  <div class="l2">
    {#each worktree.ports || [] as p (p)}
      <span class="p">{worktree.repo}:{p}</span>
    {/each}
  </div>
  <div class="quick">
    <button class="btn xs primary" onclick={() => openApp(worktree.ports[0])}>Open ↗</button>
    <button class="btn xs danger" onclick={() => stopMainServer(worktree)}>Stop</button>
  </div>
</div>

<style>
  .mcard { border:1px solid var(--border); border-radius:10px; background:var(--panel); margin:0 8px 6px;
           padding:10px 11px; box-shadow:inset 3px 0 0 var(--done); }
  .mcard:hover { border-color:var(--border-strong); }
  .l1 { display:flex; align-items:center; gap:7px; }
  .rname { font-weight:600; font-size:13px; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .l2 { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
  .l2 .p { font-family:var(--mono); font-size:10.5px; color:var(--done); }
  .src { font-family:var(--mono); font-size:9px; text-transform:uppercase; letter-spacing:.05em;
         border:1px solid var(--border); border-radius:5px; padding:1px 5px; color:var(--muted); }
  .quick { display:flex; gap:4px; margin-top:8px; }
</style>
