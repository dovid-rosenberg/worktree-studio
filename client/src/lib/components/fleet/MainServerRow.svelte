<script lang="ts">
  import type { Worktree } from '../../../../../server/types';
  /*
   * A running web dev-server in a repo's MAIN checkout. Not a worktree, therefore not a
   * feature, therefore absent from every feature row — surfaced here purely so it is
   * openable and stoppable rather than a mystery port.
   */
  import { openApp } from '$lib/stores/world.svelte.js';
  import { stopMainServer } from '$lib/ops.svelte.js';

  let { worktree }: { worktree: Worktree } = $props();
</script>

<div class="frow srvrow">
  <div class="frow-l1">
    <span class="fname">{worktree.repo} <span class="src">main</span></span>
    <span class="pill srv done"><span class="pi">⇅</span>servers · running</span>
    <span class="ports">{#each worktree.ports || [] as p (p)}<span class="p">{p}</span>{/each}</span>
    <span class="grow"></span>
    <button class="btn sm primary" onclick={() => openApp(worktree.ports[0])}>Open {worktree.repo} ↗</button>
    <button class="btn sm danger" onclick={() => stopMainServer(worktree)}>Stop</button>
  </div>
</div>

<style>
  .frow { padding:11px 16px; border-bottom:1px solid var(--border); }
  .frow:hover { background:var(--panel); }
  .frow-l1 { display:flex; align-items:center; gap:9px; row-gap:7px; flex-wrap:wrap; }
  .frow-l1 .fname { font-weight:650; font-size:13.5px; max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .frow-l1 .grow { flex:1; }
  .ports { display:inline-flex; gap:6px; flex-wrap:wrap; }
  .ports .p { font-family:var(--mono); font-size:11px; color:var(--done); }
</style>
