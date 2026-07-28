<script>
  /*
   * A feature in Fleet: a two-line row — the decision line (what state is it in, what
   * would I do next) and the stack line (which repos, which branches, which ports).
   *
   * Two clearly-labelled statuses, never merged into one: the *agent* (the Claude
   * session) and the *dev servers*. They are independent and conflating them was the
   * thing this layout was designed to stop.
   */
  import FeatureMenu from '$lib/components/fleet/FeatureMenu.svelte';
  import { openApp, webAppsFor } from '$lib/stores/world.svelte.js';
  import { ui } from '$lib/stores/ui.svelte.js';
  import {
    closeFeature, deleteFeature, openGroup, pending, prFeature,
    restartStack, runStack, startFeatureSession, stopStack,
  } from '$lib/ops.svelte.js';

  let { feature } = $props();

  const ms = $derived(feature.members.filter((/** @type {any} */ m) => m && !m.missing));
  const anyRunning = $derived(ms.some((/** @type {any} */ m) => m.running));
  const anyStartable = $derived(ms.some((/** @type {any} */ m) => m.canStart && !m.running));
  const sess = $derived(feature.session); // one session per feature
  const isPending = $derived(pending.has(feature.name));
  const webApps = $derived(webAppsFor(ms));

  let menuOpen = $state(false);
  let moreBtn = $state(/** @type {HTMLElement|null} */ (null));

  const menuItems = $derived([
    { label: 'Open in editor', run: () => openGroup(feature.name) },
    ...(anyRunning ? [{ label: 'Restart stack', run: () => restartStack(feature.name) }] : []),
    { label: 'Open PR / MR', run: () => prFeature(feature.name) },
    { sep: true },
    ...(anyRunning || sess ? [{ label: 'Close feature', run: () => closeFeature(feature.name) }] : []),
    { label: 'Delete feature…', run: () => deleteFeature(feature), danger: true },
  ]);

  /** @param {any} m */
  const memberState = (m) => (m.session ? m.session.state : (m.running ? 'done' : 'idle'));
</script>

<div class="frow">
  <div class="frow-l1">
    <span class="fname">{feature.name}{#if !feature.auto}<span class="src">manual</span>{/if}</span>

    {#if sess}
      <span class="pill agent {sess.state}" title="Agent — the Claude session">
        <span class="dot {sess.state}"></span>agent · {sess.state}
      </span>
    {/if}
    <span class="pill srv {anyRunning ? 'done' : 'idle'}" title="Dev servers">
      <span class="pi">⇅</span>servers · {anyRunning ? 'running' : 'stopped'}
    </span>

    {#if feature.slot != null}
      <span class="badge slot" title="Concurrency slot — its ports are offset by slot·100">slot {feature.slot}</span>
    {/if}

    <span class="grow"></span>

    {#if isPending}
      <button class="btn sm" disabled>working…</button>
    {:else}
      {#if sess}
        <button class="btn sm primary" onclick={() => ui.goToSession(sess.id)}>Go to session ▸</button>
      {:else}
        <button class="btn sm primary" onclick={() => startFeatureSession(feature)}>Start session</button>
      {/if}

      {#if anyRunning}
        <button class="btn sm danger" onclick={() => stopStack(feature.name)}>Stop stack</button>
      {:else if anyStartable}
        <button class="btn sm go" onclick={() => runStack(feature.name)}>Run stack</button>
      {/if}

      {#each webApps as web (web.repo)}
        <button class="btn sm" onclick={() => openApp(web.port)}>Open {web.repo} ↗</button>
      {/each}

      <button
        class="btn sm ghost fmore"
        title="More"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        bind:this={moreBtn}
        onclick={(e) => { e.stopPropagation(); menuOpen = !menuOpen; }}
      >⋯</button>
    {/if}
  </div>

  <div class="frow-l2">
    {#each ms as m (m.path)}
      <span class="mchip">
        <span class="dot {memberState(m)}" title={memberState(m)}></span>
        <span class="r">{m.repo}</span>
        <span class="br">{m.branch || m.wtname}</span>
        {#if (m.ports || []).length}
          <span class="p">{m.ports.map((/** @type {number} */ p) => ':' + p).join(' ')}</span>
        {/if}
        {#if m.merged}<span class="badge merged">✓ merged</span>{/if}
      </span>
    {/each}
  </div>
</div>

{#if menuOpen && moreBtn}
  <FeatureMenu anchor={moreBtn} items={menuItems} onclose={() => (menuOpen = false)} />
{/if}

<style>
  .frow { padding:11px 16px; border-bottom:1px solid var(--border); }
  .frow:hover { background:var(--panel); }
  .frow-l1 { display:flex; align-items:center; gap:9px; row-gap:7px; flex-wrap:wrap; }
  .frow-l1 .fname { font-weight:650; font-size:13.5px; max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:inline-flex; align-items:center; gap:6px; }
  .frow-l1 .grow { flex:1; }
  .frow-l2 { display:flex; flex-wrap:wrap; gap:8px 16px; margin-top:7px; padding-left:17px; }
  .mchip { display:inline-flex; align-items:center; gap:6px; font-family:var(--mono); font-size:11px; color:var(--muted); }
  .mchip .r { color:var(--ink); } .mchip .br { color:var(--faint); } .mchip .p { color:var(--done); }
  .fmore { font-weight:700; letter-spacing:1px; }
  .badge { font-family:var(--mono); font-size:10px; font-weight:600; padding:2px 8px; border-radius:999px; display:inline-flex; align-items:center; gap:5px; }
  .badge.merged { color:var(--done); background:var(--done-bg); }
  .badge.slot { color:var(--working); background:var(--working-bg); }
</style>
