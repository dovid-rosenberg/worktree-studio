<script>
  /*
   * The bar under the dock: the whole shared workspace (every repo this session owns),
   * its dev-server ports, the frontend "Open ↗" buttons, run/stop, and the PR/CI pills.
   *
   * CI is polled lazily per promoted session and refreshed every ~30 s while that
   * session stays selected. app.js had to re-inject the pills by hand after every SSE
   * tick because updateDock() rewrote the bar's innerHTML; here they are just state.
   */
  import { api } from '$lib/api.js';
  import { activatable } from '$lib/actions/activatable.js';
  import { world, webAppsFor, openApp } from '$lib/stores/world.svelte.js';
  import { ui } from '$lib/stores/ui.svelte.js';
  import { startSessionServers, stopSessionServers } from '$lib/ops.svelte.js';

  let { session } = $props();

  const promoted = $derived(!!session.worktreePath);
  const reps = $derived((world.servers[session.id] && world.servers[session.id].repos) || []);
  const anyRunning = $derived(reps.some((/** @type {any} */ r) => r.running));
  const anyStopped = $derived(reps.some((/** @type {any} */ r) => r.canStart && !r.running));
  const configured = $derived(reps.some((/** @type {any} */ r) => r.canStart));
  const webApps = $derived(webAppsFor(reps));

  let ci = $state(/** @type {{ sessionId: string, repos: any[] }|null} */ (null));
  const ciRepos = $derived(
    ci && ci.sessionId === session.id ? ci.repos.filter((/** @type {any} */ r) => r && r.hasPR) : [],
  );

  let busyStart = $state(false);
  let busyStop = $state(false);

  // A self-scheduling timeout (not setInterval) so a slow `gh` call can never let two
  // polls overlap. The effect's cleanup is what stops it when the selection moves on.
  $effect(() => {
    const id = session.id;
    if (!promoted) { ci = null; return; }
    let alive = true;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    const tick = async () => {
      try {
        const res = await api('GET', `/api/sessions/${id}/ci`);
        if (!alive) return;
        ci = { sessionId: id, repos: (res && res.repos) || [] };
      } catch { /* no gh/glab, no PR, offline — leave the bar as it is */ }
      if (alive) timer = setTimeout(tick, 30000);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  });

  /** One repo's check summary, in the compact form the bar has room for. */
  function checks(/** @type {any} */ r) {
    const c = r.checks || { passed: 0, running: 0, failed: 0, total: 0 };
    if (c.total === 0) return r.state ? [{ cls: '', text: String(r.state).toLowerCase() }] : [];
    /** @type {{cls:string,text:string}[]} */
    const out = [];
    if (c.passed) out.push({ cls: 'ok', text: `✓${c.passed}` });
    if (c.running) out.push({ cls: 'run', text: `◴${c.running}` });
    if (c.failed) out.push({ cls: 'x', text: `✕${c.failed}` });
    return out;
  }
</script>

<div class="serverbar">
  {#if !promoted}
    <span>Promote to a worktree to run dev servers.</span>
  {:else if !configured}
    <span>No dev-server config for this feature’s repos (set <code>start.&lt;repo&gt;</code> in config).</span>
  {:else}
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

    {#each ciRepos as r (r.repo)}
      {@const tag = (r.provider === 'gitlab' ? '!' : '#') + r.number}
      <span
        class="cistat"
        title="Open {r.provider === 'gitlab' ? 'MR' : 'PR'} {tag}"
        use:activatable={() => r.url && window.open(r.url, '_blank', 'noopener')}
      >
        <span>{r.repo} {tag}</span>
        {#each checks(r) as c (c.text)}<span class="ck {c.cls}">{c.text}</span>{/each}
      </span>
    {/each}

    <span class="spacer"></span>

    {#each webApps as web (web.repo)}
      <button class="btn sm primary" title="Open the frontend — http://localhost:{web.port}" onclick={() => openApp(web.port)}>
        Open {web.repo} ↗
      </button>
    {/each}
    {#if anyStopped}
      <button
        class="btn sm go"
        disabled={busyStart}
        onclick={async () => { busyStart = true; try { await startSessionServers(session); } finally { busyStart = false; } }}
      >{anyRunning ? 'Run rest' : 'Run all'}</button>
    {/if}
    {#if anyRunning}
      <button
        class="btn sm danger"
        disabled={busyStop}
        onclick={async () => { busyStop = true; try { await stopSessionServers(session); } finally { busyStop = false; } }}
      >Stop all</button>
    {/if}
  {/if}
</div>

<style>
  .serverbar { display:flex; align-items:center; gap:10px; row-gap:8px; flex-wrap:wrap; padding:8px 16px; border-top:1px solid var(--border); background:var(--panel); font-family:var(--mono); font-size:11.5px; color:var(--muted); flex:none; }
  .serverbar .spacer { flex:1; }
  .portchip { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--border); border-radius:6px; padding:2px 8px; }
  .cistat { display:inline-flex; align-items:center; gap:7px; border:1px solid var(--border); border-radius:6px; padding:2px 9px; cursor:pointer; color:var(--ink); }
  .cistat:hover { border-color:var(--brand); }
  .cistat .ck.ok { color:var(--done); }
  .cistat .ck.run { color:var(--waiting); }
  .cistat .ck.x { color:var(--del); }
</style>
