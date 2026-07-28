<script>
  /*
   * The dock header: state dot, title, source link, repo chips, and the per-session
   * action buttons. Rebuilt-in-place rather than re-innerHTML'd, so a button that has
   * keyboard focus keeps it while the session ticks between working and waiting.
   */
  import { labelForSource } from '$lib/stores/ui.svelte.js';
  import {
    activateSession, addRepoToSession, closeSession, deactivateSession,
    openEditor, popout, promote, renameSession,
  } from '$lib/ops.svelte.js';

  let { session } = $props();

  const promoted = $derived(!!session.worktreePath);
  /** Before promote there is one implicit chip for the primary repo. */
  const repoChips = $derived(
    session.repos && session.repos.length
      ? session.repos
      : [{ repo: session.repoName, primary: true, worktreePath: session.worktreePath }],
  );

  // One busy flag per action that fires a request — app.js's guardBtn(), as state.
  let busyPromote = $state(false);
  let busyPopout = $state(false);
  let busyActive = $state(false);

  /**
   * @param {(v: boolean) => void} set
   * @param {() => Promise<any>} fn
   */
  async function guard(set, fn) {
    set(true);
    try { await fn(); } finally { set(false); }
  }
</script>

<div class="dock-head">
  <span class="dot {session.state}"></span>
  <span class="dock-title">{session.title}</span>
  {#if session.sourceUrl}
    <a class="link" href={session.sourceUrl} target="_blank" rel="noreferrer">{labelForSource(session)}</a>
  {:else}
    <span class="src">{session.source}</span>
  {/if}

  <span class="repochips">
    {#each repoChips as r (r.repo)}
      <span
        class="repochip2"
        class:primary={r.primary}
        title={r.worktreePath || 'main (not promoted)'}
      >{r.primary ? '★ ' : ''}{r.repo}{r.worktreePath ? ' ⎇' : ''}</span>
    {/each}
  </span>

  <span class="pill {session.state}">{session.state}</span>

  <span class="dock-actions">
    <button class="btn sm" title="Add another repo to this feature" onclick={() => addRepoToSession(session)}>＋ repo</button>

    {#if !promoted}
      <button class="btn sm primary" disabled={busyPromote} onclick={() => guard((v) => (busyPromote = v), () => promote(session))}>
        ⤴ Promote to worktree
      </button>
    {:else}
      <button class="btn sm" onclick={() => openEditor(session.worktreePath)}>Open in editor</button>
    {/if}

    <button class="btn sm" aria-label="Pop out" disabled={busyPopout} onclick={() => guard((v) => (busyPopout = v), () => popout(session))}>
      Pop out ⧉
    </button>
    <button class="btn sm ghost" title="Rename" aria-label="Rename" onclick={() => renameSession(session)}>✐</button>

    {#if session.active === false}
      <button class="btn sm" disabled={busyActive} onclick={() => guard((v) => (busyActive = v), () => activateSession(session))}>Resume</button>
    {:else}
      <button
        class="btn sm ghost"
        title="Stop the process but keep the session (resumable)"
        disabled={busyActive}
        onclick={() => guard((v) => (busyActive = v), () => deactivateSession(session))}
      >Deactivate</button>
    {/if}

    <button
      class="btn sm ghost"
      title="Delete session (kills the multiplexer session)"
      aria-label="Delete session"
      onclick={() => closeSession(session)}
    >🗑</button>
  </span>
</div>

<style>
  .dock-head { display:flex; align-items:center; gap:10px; padding:12px 16px; border-bottom:1px solid var(--border); background:var(--panel); flex:none; flex-wrap:wrap; }
  .dock-title { font-weight:650; font-size:15px; max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .dock-actions { display:flex; gap:7px; align-items:center; margin-left:auto; flex-wrap:wrap; }
  .repochips { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .repochip2 { font-family:var(--mono); font-size:10.5px; color:var(--muted); border:1px solid var(--border); border-radius:6px; padding:2px 7px; }
  .repochip2.primary { color:var(--brand); border-color:var(--brand); }
</style>
