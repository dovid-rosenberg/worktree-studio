<script lang="ts">
  import type { Session } from '../../../../../server/types';
  /*
   * The bar under the dock: the whole shared workspace (every repo this session owns)
   * and its dev-server ports.
   *
   * The PR/CI pills used to live here too, and that was the wrong home: they rendered
   * only when the session was promoted AND some repo had a `start` entry, so a merge
   * request was hidden behind a dev-server condition it has nothing to do with. They are
   * LinkChips in the dock header now, beside the ticket.
   *
   * A READOUT, not a control surface, and it no longer owns a band of its own: it renders
   * INSIDE the ActionBar, left of the verbs. It used to carry `Run all` / `Run rest` /
   * `Stop all` and an `Open <repo> ↗` per frontend — the same worktrees `Run stack` /
   * `Stop stack` act on, by a different route — so one capability wore two sets of words
   * and could disagree with itself. Once the buttons went, a whole horizontal band was
   * left holding chips, with the buttons that affect those ports in a different band
   * entirely. So the chips moved to the buttons.
   *
   * No border, padding or background here: the ActionBar owns the bar, this owns the
   * chips.
   *
   */
  import { world } from '$lib/stores/world.svelte.js';

  let { session }: { session: Session } = $props();

  const promoted = $derived(!!session.worktreePath);
  const reps = $derived((world.servers[session.id] && world.servers[session.id].repos) || []);
  const configured = $derived(reps.some((r) => r.canStart));

</script>

<div class="readout">
  <!-- Both of the old empty states are gone. "Promote to a worktree to run dev servers"
       sat permanently a few pixels left of the Promote button that says the same thing,
       and the missing-config one is already a `no start cmd` pill on the rail card. A bar
       that is always saying something is a bar you stop reading. -->
  {#if promoted && configured}
    <span>workspace</span>
    {#each reps as r (r.worktreePath)}
      {#if r.running && r.ports.length}
        {#each r.ports as p (p)}
          <span class="portchip"><span class="dot done" title="running"></span>{r.repo} :{p}</span>
        {/each}
      {:else}
        <span class="portchip">
          <span class="dot {r.running ? 'done' : 'idle'}" title={r.running ? 'running' : 'stopped'}></span>{r.repo}
        </span>
      {/if}
    {/each}

{/if}
</div>

<style>
  .readout { display:flex; align-items:center; gap:9px; row-gap:6px; flex-wrap:wrap; min-width:0; font-family:var(--mono); font-size:11.5px; color:var(--muted); }
  .portchip { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--border); border-radius:6px; padding:2px 8px; }
</style>
