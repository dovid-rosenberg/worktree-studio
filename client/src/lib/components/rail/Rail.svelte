<script>
  /*
   * The session rail: repo filter, feature-grouped cards, count footer.
   *
   * Everything below is keyed — feature groups by name, cards by session id — so a
   * `session-state` frame mutates text nodes and class lists and touches nothing else.
   * The scroll position of `.rail-list` and the focus ring on a card both survive,
   * which they could not when app.js rebuilt this list from scratch on every tick.
   */
  import SessionCard from '$lib/components/rail/SessionCard.svelte';
  import { ui } from '$lib/stores/ui.svelte.js';
  import { world } from '$lib/stores/world.svelte.js';

  const groups = $derived(ui.railGroups);
  const promotedCount = $derived(world.sessions.filter((/** @type {any} */ s) => s.worktreePath).length);
  const empty = $derived(ui.visibleSessions.length === 0);
</script>

<aside class="rail">
  <div class="rail-head">
    <span id="rail-label">Sessions</span>
    <select class="mini-select" bind:value={ui.repoFilter} title="Filter by repo" aria-label="Filter by repo">
      <option value="">all repos</option>
      {#each ui.repoNames as n (n)}<option value={n}>{n}</option>{/each}
    </select>
  </div>

  <div class="rail-list" role="list" aria-labelledby="rail-label">
    {#if empty}
      <div class="rail-empty">No sessions yet. Click “+ New session”.</div>
    {/if}

    {#each groups.features as g (g.name)}
      <div class="grouphd">
        <span>⎇ {g.name}{g.members.length > 1 ? ` · ${g.members.length} repos` : ''}</span>
        <span class="gline"></span>
      </div>
      {#each g.members as s (s.id)}
        <SessionCard session={s} />
      {/each}
    {/each}

    {#if groups.loose.length}
      {#if groups.features.length}
        <div class="grouphd"><span>In main · unpromoted</span><span class="gline"></span></div>
      {/if}
      {#each groups.loose as s (s.id)}
        <SessionCard session={s} />
      {/each}
    {/if}
  </div>

  <div class="rail-foot">
    {world.sessions.length} session(s) · {promotedCount} worktree(s)
  </div>
</aside>

<style>
  .rail { border-right:1px solid var(--border); background:var(--panel); display:flex; flex-direction:column; min-height:0; }
  .rail-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:12px 14px; font-family:var(--mono); font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--faint); border-bottom:1px solid var(--border); }
  .rail-list { flex:1; overflow-y:auto; padding:8px; display:flex; flex-direction:column; gap:6px; }
  .rail-foot { padding:10px 14px; border-top:1px solid var(--border); font-family:var(--mono); font-size:10.5px; color:var(--faint); }
  .rail-empty { padding:14px; font-family:var(--mono); font-size:10.5px; color:var(--faint); }
  .grouphd { font-family:var(--mono); font-size:9.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--faint); padding:9px 6px 3px; display:flex; align-items:center; gap:7px; }
  .grouphd .gline { flex:1; height:1px; background:var(--border); }
</style>
