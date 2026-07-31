<script lang="ts">
  import type { CiRepo, Session } from '../../../../../server/types';
  /*
   * The bar under the dock: the whole shared workspace (every repo this session owns),
   * its dev-server ports, the frontend "Open ↗" buttons, run/stop, and the PR/CI pills.
   *
   * CI is PUSHED, not polled: the daemon owns when to look (server/ci.js debounces,
   * gates on a live subscriber, and only emits when the snapshot changed) and sends a
   * `ci` frame on the same stream as everything else. app.js had to re-inject the pills
   * by hand after every tick because updateDock() rewrote the bar's innerHTML; here
   * they are just derived state.
   */
  import { activatable } from '$lib/actions/activatable.js';
  import { world, webAppsFor, openApp } from '$lib/stores/world.svelte.js';
  import { ui } from '$lib/stores/ui.svelte.js';
  import { startSessionServers, stopSessionServers } from '$lib/ops.svelte.js';

  let { session }: { session: Session } = $props();

  const sessionId = $derived(session.id);
  const promoted = $derived(!!session.worktreePath);
  const reps = $derived((world.servers[session.id] && world.servers[session.id].repos) || []);
  const anyRunning = $derived(reps.some((r) => r.running));
  const anyStopped = $derived(reps.some((r) => r.canStart && !r.running));
  const configured = $derived(reps.some((r) => r.canStart));
  const webApps = $derived(webAppsFor(reps));

  // Keyed by session id, so the pills follow the selection with no effect and no timer:
  // a session the feed knows nothing about yet simply has none, and a merged or closed
  // PR disappears when the next frame drops it.
  const ciRepos = $derived(
    ((world.ci || {})[sessionId] || []).filter((r) => r && r.hasPR),
  );

  let busyStart = $state(false);
  let busyStop = $state(false);

  /** One repo's check summary, in the compact form the bar has room for. */
  function checks(r: CiRepo) {
    const c = r.checks || { passed: 0, running: 0, failed: 0, total: 0 };
    if (c.total === 0) return r.state ? [{ cls: '', text: String(r.state).toLowerCase() }] : [];
        const out: {cls:string,text:string}[] = [];
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
        class="btn sm primary"
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
