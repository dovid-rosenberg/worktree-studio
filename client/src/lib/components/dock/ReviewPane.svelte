<script lang="ts">
  /*
   * A merge request awaiting your review, opened in the dock.
   *
   * There is no terminal here and no Changes tab, because a review owns nothing on disk —
   * until you press "Check out & review", which is the whole reason a review queue belongs
   * in a tool that runs agents. That turns "four merge requests are waiting" into "four
   * agents have read them": it cuts a worktree at the MR's source branch and starts a
   * session already told what it is looking at.
   *
   * Everything else here is deliberately thin. Studio is not trying to be a code review
   * UI — GitLab already is one, and the ↗ button is one click.
   */
  import type { ReviewItem } from '../../../../../server/types';
  import { api } from '$lib/api.js';
  import { ui } from '$lib/stores/ui.svelte.js';
  import { toast } from '$lib/stores/toasts.svelte.js';
  import { errMessage } from '$lib/errmsg.js';

  let { review }: { review: ReviewItem } = $props();

  let busy = $state(false);

  /**
   * Cut a worktree at the MR's branch and point an agent at it.
   *
   * The worktree is named after the MR (`review-1906`), NOT after the branch: a feature is
   * "worktrees sharing a name", so naming it `feature/mfa-totp` would silently fold
   * somebody else's merge request into your own feature and give them one rail row
   * between them.
   */
  async function checkout() {
    busy = true;
    try {
      const r = await api('POST', '/api/v1/reviews/checkout', {
        repo: review.repo,
        branch: review.branch,
        number: review.number,
        title: review.title,
        url: review.url,
      });
      if (!r.ok) return toast(r.error || 'Could not check that out', true);
      toast(r.reused ? `Reopened the worktree for !${review.number}` : `Checked out !${review.number}`);
      // Go to the session it just made — that is what you pressed the button for.
      if (r.session?.id) ui.select(r.session.id);
    } catch (e) {
      toast(errMessage(e), true);
    } finally {
      busy = false;
    }
  }
</script>

<div class="rpane">
  <div class="head">
    <span class="g" aria-hidden="true">◇</span>
    <span class="no">!{review.number}</span>
    <h2>{review.title}</h2>
  </div>

  <div class="facts">
    <span><b>{review.repo}</b></span>
    {#if review.author}<span>by @{review.author}</span>{/if}
    {#if review.draft}<span class="tag">draft</span>{/if}
    <span class="mono">{review.branch} → {review.target}</span>
  </div>

  <div class="acts">
    <!-- The reason this queue is in an agent tool at all, so it leads. -->
    <button class="btn primary" disabled={busy} onclick={checkout}>
      {busy ? 'Checking out…' : 'Check out & review'}
    </button>
    {#if review.url}
      <a class="btn" href={review.url} target="_blank" rel="noreferrer">Open in browser ↗</a>
    {/if}
  </div>

  <p class="note">
    Checking out cuts a worktree at <code>{review.branch}</code> and starts an agent that has
    been told to read the diff against <code>{review.target}</code> and report what it finds
    — without changing anything. It becomes an ordinary row in the rail, with a terminal,
    Changes and Runs.
  </p>
</div>

<style>
  .rpane { margin:auto; max-width:560px; padding:40px 32px; }
  .head { display:flex; align-items:baseline; gap:9px; flex-wrap:wrap; }
  .head .g { color:var(--done); }
  .head .no { font-family:var(--mono); font-size:13px; color:var(--done); }
  .head h2 { margin:0; font-size:20px; line-height:1.25; }
  .facts { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-top:10px;
           font-size:13px; color:var(--muted); }
  .facts .mono { font-family:var(--mono); font-size:11.5px; color:var(--faint); }
  .tag { font-family:var(--mono); font-size:10.5px; color:var(--muted);
         border:1px solid var(--border); border-radius:5px; padding:0 5px; }
  .acts { display:flex; gap:8px; margin-top:20px; flex-wrap:wrap; }
  .note { margin-top:18px; font-size:13px; line-height:1.6; color:var(--faint); }
  .note code { font-family:var(--mono); font-size:11.5px; }
</style>
