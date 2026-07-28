<script lang="ts">
  /*
   * Fleet — the terminal-free view of everything running: features (worktrees), the
   * unpromoted agents, and every dev server that is up, including servers running from
   * a repo's MAIN checkout (which belong to no feature and are otherwise invisible).
   *
   * Ordering is deliberately stable: active first, then alphabetical, so a feature does
   * not jump around the list the moment its stack starts.
   */
  import AgentRow from '$lib/components/fleet/AgentRow.svelte';
  import FeatureRow from '$lib/components/fleet/FeatureRow.svelte';
  import ServerRow from '$lib/components/fleet/ServerRow.svelte';
  import MainServerRow from '$lib/components/fleet/MainServerRow.svelte';
  import { world } from '$lib/stores/world.svelte.js';

  /** Active = a live agent or a running dev server. @param {any} f */
  const featActive = (f: any) => f.members.some(
    (m: any) => m && !m.missing && (m.running || (m.session && m.session.state !== 'stopped')),
  );

  const feats = $derived(
    world.features.slice().sort(
      (/** @type {any} */ a, /** @type {any} */ b) => (Number(featActive(b)) - Number(featActive(a))) || a.name.localeCompare(b.name),
    ),
  );

  // Unpromoted sessions — surfaced here so Fleet is the one place you watch work.
  // Ended/deactivated ones linger as stopped, sorted after the live ones.
  const agents = $derived(
    world.sessions.filter((s: any) => !s.worktreePath).slice().sort(
      (/** @type {any} */ a, /** @type {any} */ b) =>
        (Number(a.state === 'stopped') - Number(b.state === 'stopped')) || (a.title || '').localeCompare(b.title || ''),
    ),
  );

  const serverFeats = $derived(feats.filter((f: any) => f.members.some((m: any) => m && m.running)));

  // Running frontends served from a repo's MAIN checkout — not a worktree, so not a
  // feature. Common when the backend runs in a worktree and the frontend is served from
  // its main checkout; surfacing them is what makes every running FE openable.
  const mainWebRunning = $derived((() => {
    const webSet = new Set(world.webRepos || []);
    return world.repos.flatMap((r: any) => r.worktrees || []).filter(
      (w: any) => w.isMain && webSet.has(w.repo) && w.running && (w.ports || []).length,
    );
  })());

  const nothing = $derived(!feats.length && !agents.length && !mainWebRunning.length);
</script>

<!-- The summary bar that used to sit here (counts + Stop all / Restart all) moved to the
     TopBar when Fleet became a pane: those numbers describe the whole fleet, and hiding
     them behind this one pane was the reason you had to come here to read them. -->
<section class="fleet">
  <div class="fleet-tablewrap">
    <div class="fleet-list">
      {#if nothing}
        <div class="fleet-empty">
          No worktrees or running agents. Start a session, or create a worktree by promoting one.
        </div>
      {:else}
        {#if serverFeats.length || mainWebRunning.length}
          <div class="sectionrow">⇅ Servers running · {serverFeats.length + mainWebRunning.length}</div>
          {#each serverFeats as f (f.name)}<ServerRow feature={f} />{/each}
          {#each mainWebRunning as w (w.path)}<MainServerRow worktree={w} />{/each}
        {/if}

        {#if agents.length}
          <div class="sectionrow">✦ Agents · no worktree · {agents.length}</div>
          {#each agents as s (s.id)}<AgentRow session={s} />{/each}
        {/if}

        {#if feats.length}
          <div class="sectionrow">⎇ Worktrees · {feats.length}</div>
          {#each feats as f (f.name)}<FeatureRow feature={f} />{/each}
        {/if}
      {/if}
    </div>
  </div>
</section>

<style>
  .fleet { flex:1; min-height:0; background:var(--bg); display:flex; flex-direction:column; }
  .fleet-tablewrap { flex:1; min-height:0; overflow:auto; padding:0 0 40px; }
  .fleet-list { display:flex; flex-direction:column; }
  .fleet-empty { color:var(--faint); padding:22px 16px; font-size:13px; }
  .sectionrow { font-family:var(--mono); font-size:9.5px; letter-spacing:.09em; text-transform:uppercase; color:var(--brand); background:var(--elevated); padding:7px 16px; border-bottom:1px solid var(--border); font-weight:700; position:sticky; top:0; z-index:2; }
</style>
