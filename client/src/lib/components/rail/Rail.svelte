<script lang="ts">
  /*
   * The rail: repo filter, four sections, count footer.
   *
   * The sections are Fleet's, in Fleet's order, because this is where Fleet's content
   * went. Read stores/ui.svelte.js for why the rail is keyed on features and what had to
   * come across with the rows (ordering and filter semantics, both silent if dropped).
   *
   * The Servers-running section deliberately REPEATS features that also appear under
   * Worktrees. ServerRow.svelte states the reason outright: "when servers are running,
   * this is the section you watch, so the browse buttons belong here too rather than only
   * further down the page." It reads like duplication to tidy away. It is not.
   *
   * Everything below is keyed — features by name, cards by session id — so a
   * `session-state` frame mutates text nodes and class lists and touches nothing else.
   * The scroll position of `.rail-list` and the focus ring on a card both survive, which
   * they could not when app.js rebuilt this list from scratch on every tick.
   */
  import FeatureCard from '$lib/components/rail/FeatureCard.svelte';
  import MainServerCard from '$lib/components/rail/MainServerCard.svelte';
  import SessionCard from '$lib/components/rail/SessionCard.svelte';
  import { ui } from '$lib/stores/ui.svelte.js';
  import { world } from '$lib/stores/world.svelte.js';

  const feats = $derived(ui.visibleFeatures);
  const servers = $derived(ui.serverFeatures);
  const agents = $derived(ui.visibleAgents);
  const mains = $derived(ui.visibleMainServers);

  const sessionless = $derived(feats.filter((f: any) => !f.session).length);
  const empty = $derived(!feats.length && !agents.length && !mains.length);
</script>

<aside class="rail">
  <div class="rail-head">
    <span id="rail-label">Features</span>
    <!-- Matches on any MEMBER repo: filtering to one repo must not split a BE+FE feature. -->
    <select class="mini-select" bind:value={ui.repoFilter} title="Filter by repo" aria-label="Filter by repo">
      <option value="">all repos</option>
      {#each ui.repoNames as n (n)}<option value={n}>{n}</option>{/each}
    </select>
  </div>

  <p class="sortnote">active first, then A–Z</p>

  <div class="rail-list" role="list" aria-labelledby="rail-label">
    {#if empty}
      <div class="rail-empty">
        No worktrees or agents yet. Click “+ New session”, or create a worktree by promoting one.
      </div>
    {/if}

    {#if servers.length}
      <div class="sectionrow">⇅ Servers running · {servers.length}</div>
      {#each servers as f (f.name)}<FeatureCard feature={f} />{/each}
    {/if}

    {#if mains.length}
      <div class="sectionrow">⇅ Servers · no worktree · {mains.length}</div>
      {#each mains as w (w.path)}<MainServerCard worktree={w} />{/each}
    {/if}

    {#if agents.length}
      <div class="sectionrow">✦ Agents · no worktree · {agents.length}</div>
      {#each agents as s (s.id)}<SessionCard session={s} />{/each}
    {/if}

    {#if feats.length}
      <div class="sectionrow">⎇ Worktrees · {feats.length}</div>
      {#each feats as f (f.name)}<FeatureCard feature={f} />{/each}
    {/if}
  </div>

  <div class="rail-foot">
    {feats.length} feature(s) · {world.sessions.length} session(s){sessionless ? ` · ${sessionless} without an agent` : ''}
  </div>
</aside>

<style>
  .rail { border-right:1px solid var(--border); background:var(--panel); display:flex; flex-direction:column; min-height:0; }
  .rail-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:12px 14px; font-family:var(--mono); font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--faint); border-bottom:1px solid var(--border); }
  .sortnote { margin:0; padding:5px 14px; font-family:var(--mono); font-size:9.5px; color:var(--faint); border-bottom:1px solid var(--border); }
  /* overflow-x:hidden is load-bearing: a long branch name must truncate inside its card,
     never widen the rail into a horizontal scrollbar. */
  .rail-list { flex:1; overflow-y:auto; overflow-x:hidden; padding:8px 0; display:flex; flex-direction:column; }
  .rail-foot { padding:10px 14px; border-top:1px solid var(--border); font-family:var(--mono); font-size:10.5px; color:var(--faint); }
  .rail-empty { padding:14px; font-family:var(--mono); font-size:10.5px; color:var(--faint); }
  .sectionrow { font-family:var(--mono); font-size:9.5px; letter-spacing:.09em; text-transform:uppercase; color:var(--brand); background:var(--elevated); padding:6px 14px; border-top:1px solid var(--border); border-bottom:1px solid var(--border); font-weight:700; position:sticky; top:0; z-index:2; margin-bottom:6px; }
</style>
