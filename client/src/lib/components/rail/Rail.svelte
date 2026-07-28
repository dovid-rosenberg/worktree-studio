<script lang="ts">
  /*
   * The rail: repo filter, one flat list, count footer.
   *
   * ONE ROW PER THING. This used to be four sections — Servers running, Servers · no
   * worktree, Agents · no worktree, Worktrees — and a feature with a dev server up
   * appeared in two of them. The justification (fleet/ServerRow: "when servers are
   * running, this is the section you watch, so the browse buttons belong here too")
   * expired when every action moved to the ActionBar: the duplicate carried no buttons,
   * so it was the same readout drawn twice.
   *
   * NO BUCKETS. "Running" conflates two unrelated facts — dev servers up, and agent
   * state — so a section keyed on it would file a *waiting* agent, the one row that
   * actually wants the user, among worktrees untouched for a month. Instead every row
   * sorts on `active` and a single divider marks where the quiet ones start.
   *
   * That also retires four `position:sticky; top:0` headers sharing one scroller, which
   * collided as you scrolled past them.
   *
   * Keyed by `row.key` so a `session-state` frame mutates text nodes and class lists and
   * touches nothing else: scroll position and the focus ring on a card both survive.
   */
  import FeatureCard from '$lib/components/rail/FeatureCard.svelte';
  import MainServerCard from '$lib/components/rail/MainServerCard.svelte';
  import SessionCard from '$lib/components/rail/SessionCard.svelte';
  import { ui } from '$lib/stores/ui.svelte.js';

  const rows = $derived(ui.railRows);
  const dividerAt = $derived(ui.dividerAt);
  const quiet = $derived(dividerAt < 0 ? 0 : rows.length - dividerAt);
</script>

<aside class="rail">
  <div class="rail-head">
    <span id="rail-label">Work</span>
    <!-- Matches on any MEMBER repo: filtering to one repo must not split a BE+FE feature. -->
    <select class="mini-select" bind:value={ui.repoFilter} title="Filter by repo" aria-label="Filter by repo">
      <option value="">all repos</option>
      {#each ui.repoNames as n (n)}<option value={n}>{n}</option>{/each}
    </select>
  </div>

  <div class="rail-list" role="list" aria-labelledby="rail-label">
    {#if !rows.length}
      <div class="rail-empty">
        Nothing here yet. Click “+ New session”, or create a worktree by promoting one.
      </div>
    {/if}

    {#each rows as row, i (row.key)}
      {#if i === dividerAt}
        <div class="divider"><span>idle · {quiet}</span></div>
      {/if}
      {#if row.kind === 'feature'}
        <FeatureCard feature={row.feature} />
      {:else if row.kind === 'agent'}
        <SessionCard session={row.session} />
      {:else}
        <MainServerCard worktree={row.worktree} />
      {/if}
    {/each}
  </div>

  <!-- Counts what is drawn. It used to say "N feature(s)" while the list also held
       agents and main-checkout servers, so the number never matched the rows. -->
  <div class="rail-foot">
    {rows.length} row(s){quiet ? ` · ${quiet} idle` : ''}
  </div>
</aside>

<style>
  .rail { border-right:1px solid var(--border); background:var(--panel); display:flex; flex-direction:column; min-height:0; }
  .rail-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:12px 14px; font-family:var(--mono); font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--faint); border-bottom:1px solid var(--border); }
  /* overflow-x:hidden is load-bearing: a long branch name must truncate inside its card,
     never widen the rail into a horizontal scrollbar. */
  .rail-list { flex:1; overflow-y:auto; overflow-x:hidden; padding:8px 0; display:flex; flex-direction:column; }
  .rail-foot { padding:10px 14px; border-top:1px solid var(--border); font-family:var(--mono); font-size:10.5px; color:var(--faint); }
  .rail-empty { padding:14px; font-family:var(--mono); font-size:10.5px; color:var(--faint); }

  /* A hairline, not a header: it separates, it does not label a category. Deliberately
     not sticky — the four sticky headers it replaces used to pile up on each other. */
  .divider { display:flex; align-items:center; gap:9px; margin:6px 12px 8px; }
  .divider::after { content:''; flex:1; height:1px; background:var(--border); }
  .divider span { font-family:var(--mono); font-size:9.5px; letter-spacing:.09em; text-transform:uppercase; color:var(--faint); }
</style>
