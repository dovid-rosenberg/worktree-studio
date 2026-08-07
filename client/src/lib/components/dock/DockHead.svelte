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
  import { world } from '$lib/stores/world.svelte.js';

  let { session }: { session: Session } = $props();

  /*
   * The worktree name, when it is not already what the title says.
   *
   * The rail shows `session.title || feature.name` and the dock showed `session.title`
   * alone — so after a rename the two surfaces named the same thing differently, and the
   * worktree identity (what groups the repos, what `wt` and tmux use, what the paths are)
   * appeared in the dock nowhere at all. Mirrors FeatureCard's second line exactly, and
   * is absent for the untouched majority whose title IS the worktree name.
   */
  const wtname = $derived(world.featureFor(session.id)?.name || '');
  const showWtname = $derived(!!wtname && wtname !== session.title.trim());

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
  {#if showWtname}<span class="wtname" title="The worktree name — what groups these repos">{wtname}</span>{/if}
  {#if session.sourceUrl}
    <a class="link" href={session.sourceUrl} target="_blank" rel="noreferrer">{labelForSource(session)}</a>
  {:else}
    <!-- Only a source worth naming. Every locally-created session has source 'text',
         so this printed the literal word "text" on the header of most features forever.
         FeatureCard suppresses defaults the same way. -->
    {#if session.source && session.source !== 'text'}<span class="src">{session.source}</span>{/if}
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

</div>

<style>
  /* The feature's colour tag, inherited from .dock (see Dock.svelte). This is the surface
     that matters: the rail is what you SCAN, but the dock is what you are looking at while
     you work, so a tag only in the rail would be invisible at the moment you switch.
     `var(--fc, …)` falls back to the untagged look, so nothing changes without a tag. */
  .dock-head { display:flex; align-items:center; gap:10px; padding:12px 16px; border-bottom:1px solid var(--border);
               background:var(--fc-wash, var(--panel)); box-shadow:inset 4px 0 0 var(--fc, transparent);
               flex:none; flex-wrap:wrap; }
  .wtname { font-family:var(--mono); font-size:11.5px; color:var(--faint); overflow:hidden;
            text-overflow:ellipsis; white-space:nowrap; max-width:220px; }
  .dock-title { font-weight:650; font-size:16px; max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .repochips { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .repochip2 { font-family:var(--mono); font-size:11.5px; color:var(--muted); border:1px solid var(--border); border-radius:6px; padding:2px 7px; }
  .repochip2.primary { color:var(--brand); border-color:var(--brand); }
</style>
