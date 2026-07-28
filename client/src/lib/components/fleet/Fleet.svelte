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
  import { liveMembers, ui } from '$lib/stores/ui.svelte.js';

  /*
   * Every list here comes from the ui store rather than being recomputed.
   *
   * This component used to carry its own featActive/sort/filter/main-server logic, a
   * verbatim copy of the store's. That was the source the rail was ported FROM, so the
   * two were the same code in two places — and the store's copy is the one the rail,
   * the top bar and ⌘1–9 already read. A second definition of "active" is exactly how
   * the two surfaces drift into disagreeing about which features are running.
   *
   * The store's lists are repo-filtered, and Overview takes them as-is: the filter is
   * one control with one meaning, and it sits in the rail right beside this pane. Half
   * a filter — the rail narrowed, the overview not — is the confusing option.
   */
  const feats = $derived(ui.visibleFeatures);
  const agents = $derived(ui.visibleAgents);
  const serverFeats = $derived(feats.filter((f) => liveMembers(f).some((m) => m.running)));
  const mainWebRunning = $derived(ui.visibleMainServers);

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
