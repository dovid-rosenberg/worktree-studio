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
import StateDot from '$lib/components/StateDot.svelte';

let { worktree }: { worktree: Worktree } = $props();

const selected = $derived(ui.selection?.kind === 'mainserver' && ui.selection.path === worktree.path);
</script>

<!-- `.sel`, not `.on`: three cards said `sel` and this one said `on` for the same state. -->
<div class="railcard mcard" role="listitem" class:sel={selected}>
  <!-- aria-pressed and a name, which its three siblings all carry and this one did not —
       so the only selectable row announced neither what it was nor whether it was on. -->
  <button
    class="hit"
    type="button"
    onclick={() => ui.selectMainServer(worktree.path)}
    aria-pressed={selected}
    aria-label="Select {worktree.repo}’s main-checkout dev server"
  >
    <span class="l1">
      <!-- Not an agent: this row has none. The dot means the server is up. -->
      <StateDot state="done" label="Dev server running" />
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
  /* Shell in app.css (`.railcard`), including the whole-card button — this card used to
     carry the padding itself and zero it on the button, which is the same geometry
     spelled the other way round. */
  .mcard { box-shadow:inset 3px 0 0 var(--done); }
  .l1 { display:flex; align-items:center; gap:7px; }
  .rname { font-weight:600; font-size:14px; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .l2 { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
  .l2 .p { font-family:var(--mono); font-size:11.5px; color:var(--done); }
</style>
