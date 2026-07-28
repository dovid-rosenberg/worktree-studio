<script>
  /*
   * What the dock shows for a feature with no agent.
   *
   * This is the surface the session-keyed rail could not express at all: with no session
   * there is no id to select, so `groupRail()` never emitted a row and the worktree was
   * invisible in Work. There is likewise no terminal to mount, so the dock shows the
   * stack instead — repos, branches, ports, merge state — plus every feature-scoped
   * action, so nothing requires a detour through Overview.
   */
  import { openApp, webAppsFor } from '$lib/stores/world.svelte.js';
  import { liveMembers } from '$lib/stores/ui.svelte.js';
  import {
    closeFeature, deleteFeature, openGroup, pending, prFeature,
    restartStack, runStack, startFeatureSession, stopStack,
  } from '$lib/ops.svelte.js';

  let { feature } = $props();

  const ms = $derived(liveMembers(feature));
  const anyRunning = $derived(ms.some((/** @type {any} */ m) => m.running));
  const anyStartable = $derived(ms.some((/** @type {any} */ m) => m.canStart && !m.running));
  const isPending = $derived(pending.has(feature.name));
  const webApps = $derived(webAppsFor(ms));

  /** @param {any} m */
  const memberState = (m) => (m.session ? m.session.state : (m.running ? 'done' : 'idle'));
</script>

<div class="fpane">
  <div class="head">
    <h2>{feature.name}</h2>
    {#if !feature.auto}<span class="src" title="Grouped by config.groups, not by shared name">manual</span>{/if}
    {#if feature.slot != null}
      <span class="badge slot" title="Concurrency slot — its ports are offset by slot·100">slot {feature.slot}</span>
    {/if}
  </div>
  <p class="sub">
    {ms.length} repo{ms.length === 1 ? '' : 's'} · no agent ·
    {feature.auto ? 'grouped by shared worktree name' : 'grouped by config.groups'}
  </p>

  <div class="cta">
    {#if isPending}
      <button class="btn primary" disabled>working…</button>
    {:else}
      <button class="btn primary" onclick={() => startFeatureSession(feature)}>Start session here</button>
      {#if anyRunning}
        <button class="btn danger" onclick={() => stopStack(feature.name)}>Stop stack</button>
        <button class="btn" onclick={() => restartStack(feature.name)}>Restart stack</button>
      {:else if anyStartable}
        <button class="btn go" onclick={() => runStack(feature.name)}>Run stack</button>
      {/if}
      {#each webApps as web (web.repo)}
        <button class="btn" onclick={() => openApp(web.port)}>Open {web.repo} ↗</button>
      {/each}
      <button class="btn" onclick={() => openGroup(feature.name)}>Open in editor</button>
      <button class="btn" onclick={() => prFeature(feature.name)}>Open PR / MR</button>
      {#if anyRunning}
        <button class="btn ghost" onclick={() => closeFeature(feature.name)}>Close feature</button>
      {/if}
      <button class="btn ghost danger-text" onclick={() => deleteFeature(feature)}>Delete feature…</button>
    {/if}
  </div>

  <div class="tablewrap">
    <table class="rtable">
      <thead>
        <tr><th>Repo</th><th>Branch</th><th>Servers</th><th>Ports</th><th>State</th></tr>
      </thead>
      <tbody>
        {#each ms as m (m.path)}
          <tr>
            <td class="r">{m.repo}</td>
            <td>{m.branch || m.wtname}{#if m.merged}<span class="badge merged">✓ merged</span>{/if}</td>
            <td>{m.running ? 'running' : 'stopped'}</td>
            <td class="ports">{(m.ports || []).length ? m.ports.map((/** @type {number} */ p) => m.repo + ':' + p).join(' ') : '—'}</td>
            <td><span class="pill {memberState(m)}">{memberState(m)}</span></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>

<style>
  .fpane { flex:1; min-height:0; overflow:auto; padding:24px 22px 40px; }
  .head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .head h2 { margin:0; font-size:20px; letter-spacing:-.01em; }
  .sub { margin:5px 0 20px; font-family:var(--mono); font-size:11.5px; color:var(--faint); }
  .cta { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:26px; }
  .danger-text { color:#e5484d; }

  .tablewrap { overflow-x:auto; border:1px solid var(--border); border-radius:10px; background:var(--panel); }
  .rtable { width:100%; border-collapse:collapse; font-family:var(--mono); font-size:11.5px; min-width:560px; }
  .rtable th { text-align:left; font-size:9.5px; letter-spacing:.09em; text-transform:uppercase; color:var(--faint); font-weight:700; padding:8px 12px; border-bottom:1px solid var(--border); background:var(--elevated); white-space:nowrap; }
  .rtable td { padding:9px 12px; border-bottom:1px solid var(--border); color:var(--muted); }
  .rtable tr:last-child td { border-bottom:none; }
  .rtable td.r { color:var(--ink); }
  .rtable td.ports { color:var(--done); font-variant-numeric:tabular-nums; }
  .badge { font-family:var(--mono); font-size:10px; font-weight:600; padding:2px 8px; border-radius:999px; margin-left:8px; }
  .badge.merged { color:var(--done); background:var(--done-bg); }
  .badge.slot { color:var(--working); background:var(--working-bg); }
  .src { font-family:var(--mono); font-size:9.5px; text-transform:uppercase; letter-spacing:.05em; border:1px solid var(--border); border-radius:5px; padding:1px 6px; color:var(--muted); }
</style>
