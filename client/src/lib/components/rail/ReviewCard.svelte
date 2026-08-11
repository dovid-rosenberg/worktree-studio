<script lang="ts">
/*
 * A merge request waiting on YOU.
 *
 * SAME GRAMMAR AS A FEATURE CARD — a mark, a name, then a line of facts — because the
 * rail is one list and a row that invents its own layout reads as a different app. What
 * differs is the mark and the colour: a diamond rather than a state dot, and the "done"
 * hue rather than the feature's own, because the one thing you must not confuse is
 * whose work this is.
 *
 * A review has no agent, no dev server and no worktree, so there is no state to show —
 * only who wrote it, how old it is, and whether it is a draft.
 */
import type { ReviewItem } from '../../../../../server/types';
import { ui } from '$lib/stores/ui.svelte.js';

let { review }: { review: ReviewItem } = $props();

const selected = $derived(
  ui.selection?.kind === 'review' && ui.selection.id === `${review.repo}!${review.number}`,
);

/**
 * Age, in the coarsest unit that is still true.
 *
 * A review's age is the whole argument for looking at it, and "5d" says that where a
 * timestamp does not. Hours below a day, because a morning's MR and last week's are
 * different asks.
 */
const age = $derived.by(() => {
  const t = Date.parse(review.updatedAt || '');
  if (!Number.isFinite(t)) return '';
  const h = Math.floor((Date.now() - t) / 3_600_000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
});
</script>

<div class="rcard" class:sel={selected} class:draft={review.draft} role="listitem">
  <button
    class="hit"
    onclick={() => ui.selectReview(review)}
    aria-pressed={selected}
    aria-label="Review {review.repo} !{review.number}: {review.title}"
  >
    <div class="l1">
      <span class="g" aria-hidden="true">◇</span>
      <span class="no">!{review.number}</span>
      <span class="nm">{review.title}</span>
    </div>
    <div class="l2">
      <span class="m">{review.repo}</span>
      {#if review.author}<span class="who">@{review.author}</span>{/if}
      {#if review.draft}<span class="tag">draft</span>{/if}
      <!-- The target branch, ONLY when it is not the repo's default. A merge request
           stacked on another branch is a different thing to review, and the rest of the
           time the target is noise. The server sends it either way; this decides. -->
      {#if review.target && !/^(main|master|develop|dev)$/.test(review.target)}
        <span class="tgt" title="Targets {review.target} — this is stacked on another branch">→ {review.target}</span>
      {/if}
      {#if age}<span class="m">{age}</span>{/if}
    </div>
  </button>
</div>

<style>
  /* Bordered like a feature card, tagged down the left like one too — but in the review
     hue, which is the only cue that has to survive a fast scan. */
  .rcard { margin:4px 8px; border:1px solid var(--border); border-radius:9px;
           background:var(--panel); box-shadow:inset 3px 0 0 var(--done); }
  .rcard.sel { border-color:var(--brand); }
  /* A draft is somebody thinking out loud: still listed, still openable, just not the
     thing to do next. */
  .rcard.draft { opacity:.62; }
  .rcard.draft:hover { opacity:1; }

  .hit { display:block; width:100%; background:none; border:0; padding:8px 10px;
         text-align:left; color:inherit; font:inherit; cursor:pointer; }
  .l1 { display:flex; align-items:center; gap:7px; min-width:0; }
  .l2 { display:flex; align-items:center; gap:7px; flex-wrap:wrap; margin-top:3px; }
  .g { color:var(--done); font-size:10px; flex:none; }
  .no { font-family:var(--mono); font-size:10.5px; color:var(--done); flex:none; }
  .nm { font-weight:600; font-size:13px; min-width:0; overflow:hidden;
        text-overflow:ellipsis; white-space:nowrap; }
  .m, .who { font-family:var(--mono); font-size:10.5px; color:var(--faint); }
  .tag { font-family:var(--mono); font-size:10px; color:var(--muted);
         border:1px solid var(--border); border-radius:5px; padding:0 4px; }
  .tgt { font-family:var(--mono); font-size:10px; color:var(--waiting); }
</style>
