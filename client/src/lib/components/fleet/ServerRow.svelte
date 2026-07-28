<script>
  /*
   * A compact readout of a feature whose dev servers are up. It overlaps the Worktrees
   * section on purpose: when servers are running, this is the section you watch, so the
   * browse buttons belong here too rather than only further down the page.
   */
  import { openApp, webAppsFor } from '$lib/stores/world.svelte.js';
  import { ui } from '$lib/stores/ui.svelte.js';
  import { stopStack } from '$lib/ops.svelte.js';

  let { feature } = $props();

  const ports = $derived(
    feature.members
      .filter((/** @type {any} */ m) => m && m.running)
      .flatMap((/** @type {any} */ m) => (m.ports || []).map((/** @type {number} */ p) => `${m.repo}:${p}`)),
  );
  const webApps = $derived(webAppsFor(feature.members.filter((/** @type {any} */ m) => m && !m.missing)));
</script>

<div class="frow srvrow">
  <div class="frow-l1">
    <span class="fname">{feature.name}</span>
    <span class="pill srv done"><span class="pi">⇅</span>servers · running</span>
    <span class="ports">{#each ports as p (p)}<span class="p">{p}</span>{/each}</span>
    <span class="grow"></span>
    {#each webApps as web (web.repo)}
      <button class="btn sm primary" onclick={() => openApp(web.port)}>Open {web.repo} ↗</button>
    {/each}
    {#if feature.session}
      <button class="btn sm" onclick={() => ui.goToSession(feature.session.id)}>Go to session ▸</button>
    {/if}
    <button class="btn sm danger" onclick={() => stopStack(feature.name)}>Stop stack</button>
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
