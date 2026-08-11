<script lang="ts">
import type { Worktree } from '../../../../../server/types';
/*
 * A dev server running from a repo's MAIN checkout. Not a worktree, so not a feature,
 * so it appears in no other list — this row exists so it is not a mystery port.
 *
 * The `repo:port` label is deliberate and matches Fleet's server sections: with several
 * of these up, a bare `:5271` does not say whose it is.
 *
 * It used to carry Open ↗ and Stop — the ONLY buttons in the rail, an exception to the
 * rule stated in Rail.svelte, and it existed only because this row could not be
 * selected so the ActionBar had nothing to act on. It is a selection now and the verbs
 * are at the bottom with every other verb.
 */
import { ui } from '$lib/stores/ui.svelte.js';

let { worktree }: { worktree: Worktree } = $props();

const selected = $derived(ui.selection?.kind === 'mainserver' && ui.selection.path === worktree.path);
</script>

<div class="mcard" role="listitem" class:on={selected}>
  <button class="hit" type="button" onclick={() => ui.selectMainServer(worktree.path)}>
    <span class="l1">
      <span class="dot done"></span>
      <span class="rname">{worktree.repo}</span>
      <span class="src">main</span>
    </span>
    <span class="l2">
      {#each worktree.ports || [] as p (p)}
        <span class="p">{worktree.repo}:{p}</span>
      {/each}
    </span>
  </button>
</div>

<style>
  .mcard { border:1px solid var(--border); border-radius:10px; background:var(--panel); margin:0 8px 6px;
           padding:10px 11px; box-shadow:inset 3px 0 0 var(--done); }
  .mcard:hover { border-color:var(--border-strong); }
  .mcard.on { border-color:var(--brand); }
  /* A whole-card button, so the hit area is the card and not a strip inside it. */
  .hit { display:block; width:100%; text-align:left; background:none; border:0; padding:0; cursor:pointer; color:inherit; font:inherit; }
  .l1 { display:flex; align-items:center; gap:7px; }
  .rname { font-weight:600; font-size:14px; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .l2 { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
  .l2 .p { font-family:var(--mono); font-size:11.5px; color:var(--done); }
  .src { font-family:var(--mono); font-size:10px; text-transform:uppercase; letter-spacing:.05em;
         border:1px solid var(--border); border-radius:5px; padding:1px 5px; color:var(--muted); }
</style>
