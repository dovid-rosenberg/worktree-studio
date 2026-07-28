<script lang="ts">
  /* An unpromoted agent. Live → Promote is the obvious next step; stopped → Resume. */
  import { ui } from '$lib/stores/ui.svelte.js';
  import { activateSession, closeSession, promote } from '$lib/ops.svelte.js';

  let { session } = $props();

  const stopped = $derived(session.state === 'stopped');
  const reps = $derived(session.repos && session.repos.length ? session.repos : [{ repo: session.repoName }]);
</script>

<div class="frow" class:stoppedrow={stopped}>
  <div class="frow-l1">
    <span class="fname">{session.title || 'session'}</span>
    <span class="pill agent {session.state}" title="Agent — the Claude session">
      <span class="dot {session.state}"></span>agent · {session.state}
    </span>
    <span class="pill srv nowt" title="Not promoted — no worktree yet"><span class="pi">✦</span>no worktree</span>
    <span class="grow"></span>

    {#if stopped}
      <button class="btn sm go" onclick={() => activateSession(session)}>↻ Resume</button>
      <button class="btn sm" onclick={() => ui.goToSession(session.id)}>Go to session ▸</button>
    {:else}
      <button class="btn sm primary" onclick={() => ui.goToSession(session.id)}>Go to session ▸</button>
      <button class="btn sm go" onclick={() => promote(session)}>⤴ Promote</button>
    {/if}
    <button class="btn sm ghost" title="Delete session" aria-label="Delete session" onclick={() => closeSession(session)}>🗑</button>
  </div>

  <div class="frow-l2">
    {#each reps as r (r.repo)}
      <span class="mchip">
        <span class="dot {session.state}" title={session.state}></span>
        <span class="r">{r.repo}</span> <span class="br">in main · no worktree</span>
      </span>
    {/each}
  </div>
</div>

<style>
  .frow { padding:11px 16px; border-bottom:1px solid var(--border); }
  .frow:hover { background:var(--panel); }
  .frow.stoppedrow .fname, .frow.stoppedrow .frow-l2 { opacity:.55; }
  .frow-l1 { display:flex; align-items:center; gap:9px; row-gap:7px; flex-wrap:wrap; }
  .frow-l1 .fname { font-weight:650; font-size:13.5px; max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .frow-l1 .grow { flex:1; }
  .frow-l2 { display:flex; flex-wrap:wrap; gap:8px 16px; margin-top:7px; padding-left:17px; }
  .mchip { display:inline-flex; align-items:center; gap:6px; font-family:var(--mono); font-size:11px; color:var(--muted); }
  .mchip .r { color:var(--ink); } .mchip .br { color:var(--faint); }
</style>
