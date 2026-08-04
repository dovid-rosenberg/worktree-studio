<script lang="ts">
  import type { Session } from '../../../../../server/types';
  /*
   * The dock header: IDENTITY ONLY — state dot, title, source link, repo chips, state.
   *
   * It used to carry ＋repo, Promote, Open in editor, Rename, Resume/Deactivate and
   * Delete as well. Every one of those also lives in the ActionBar, ~600px below, and
   * two of them were worded differently in the two places (`Resume` vs `↻ Resume`) —
   * so the same verb appeared twice on one screen and looked like two verbs.
   *
   * The rule this settles: the top says WHAT you are looking at, the bottom DOES
   * something to it. (The tab strip stays on top for the same reason — its controls
   * switch views, they do not act on the selection.)
   */
  import { labelForSource } from '$lib/stores/ui.svelte.js';

  let { session }: { session: Session } = $props();

  /** Before promote there is one implicit chip for the primary repo. */
  const repoChips = $derived(
    session.repos && session.repos.length
      ? session.repos
      : [{ repo: session.repoName, primary: true, worktreePath: session.worktreePath }],
  );


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

</div>

<style>
  .dock-head { display:flex; align-items:center; gap:10px; padding:12px 16px; border-bottom:1px solid var(--border); background:var(--panel); flex:none; flex-wrap:wrap; }
  .dock-title { font-weight:650; font-size:15px; max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .repochips { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .repochip2 { font-family:var(--mono); font-size:10.5px; color:var(--muted); border:1px solid var(--border); border-radius:6px; padding:2px 7px; }
  .repochip2.primary { color:var(--brand); border-color:var(--brand); }
</style>
