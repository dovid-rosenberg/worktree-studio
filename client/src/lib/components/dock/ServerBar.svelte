<script lang="ts">
  import type { CiRepo, Session } from '../../../../../server/types';
  /*
   * The bar under the dock: the whole shared workspace (every repo this session owns),
   * its dev-server ports, and the PR/CI pills.
   *
   * A READOUT, not a control surface. It used to carry `Run all` / `Run rest` / `Stop all`
   * and an `Open <repo> ↗` per frontend — the same worktrees the ActionBar's `Run stack` /
   * `Stop stack` act on, by a different route (the session endpoints rather than the group
   * ones), so one capability wore two sets of words and could disagree with itself. The
   * verbs live at the bottom now; this says what is true.
   *
   * CI is PUSHED, not polled: the daemon owns when to look (server/ci.js debounces,
   * gates on a live subscriber, and only emits when the snapshot changed) and sends a
   * `ci` frame on the same stream as everything else. app.js had to re-inject the pills
   * by hand after every tick because updateDock() rewrote the bar's innerHTML; here
   * they are just derived state.
   */
  import { activatable } from '$lib/actions/activatable.js';
  import { world } from '$lib/stores/world.svelte.js';
  import { ui } from '$lib/stores/ui.svelte.js';

  let { session }: { session: Session } = $props();

  const sessionId = $derived(session.id);
  const promoted = $derived(!!session.worktreePath);
  const reps = $derived((world.servers[session.id] && world.servers[session.id].repos) || []);
  const configured = $derived(reps.some((r) => r.canStart));

  // Keyed by session id, so the pills follow the selection with no effect and no timer:
  // a session the feed knows nothing about yet simply has none, and a merged or closed
  // PR disappears when the next frame drops it.
  const ciRepos = $derived(
    ((world.ci || {})[sessionId] || []).filter((r) => r && r.hasPR),
  );

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

  {/if}
</div>

<style>
  .serverbar { display:flex; align-items:center; gap:10px; row-gap:8px; flex-wrap:wrap; padding:8px 16px; border-top:1px solid var(--border); background:var(--panel); font-family:var(--mono); font-size:11.5px; color:var(--muted); flex:none; }
  .portchip { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--border); border-radius:6px; padding:2px 8px; }
  .cistat { display:inline-flex; align-items:center; gap:7px; border:1px solid var(--border); border-radius:6px; padding:2px 9px; cursor:pointer; color:var(--ink); }
  .cistat:hover { border-color:var(--brand); }
  .cistat .ck.ok { color:var(--done); }
  .cistat .ck.run { color:var(--waiting); }
  .cistat .ck.x { color:var(--del); }
</style>
