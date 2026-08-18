<script lang="ts">
import type { FileHunks } from './api';
/*
 * The Changes panel: per repo, the branch's commits plus an uncommitted entry, with a
 * diff pane beside it. Self-contained — it owns its own fetching and its own state, and
 * deliberately does not reach for a global store, so the app shell can mount it with
 * nothing but a session id.
 *
 * TWO SOURCES OF DIFF, and the distinction matters:
 *
 *   a commit          → GET /commit-detail. `f.parsed` is the whole story; commits are
 *                       immutable, so there is nothing to stage and no second call.
 *
 *   the working tree  → GET /commit-detail gives the FILE LIST (status + counts, and a
 *                       `git diff HEAD` to show instantly), but that diff merges staged
 *                       and unstaged changes into one picture, and staging acts on them
 *                       separately. So each file also gets GET /hunks, which splits the
 *                       same changes into `unstaged` (index→worktree, stageable) and
 *                       `staged` (HEAD→index, unstageable). Once it arrives the file
 *                       renders from THAT, so every hunk shown is a hunk the adjacent
 *                       button actually acts on. Rendering the merged diff with stage
 *                       buttons on it would be a lie the moment anything is half-staged.
 *
 * Staging responses carry a fresh both-sides payload for the file, so a stage/unstage
 * updates that one file in place — no refetch, no flicker, and no chance of a stale
 * hunk index.
 */
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { fetchCommits, fetchCommitDetail, fetchHunks, applyHunks } from './api.js';
import { refusal, pairRenames, isRenameSummaryPath } from './model.js';
import { activatable } from '$lib/actions/activatable.js';
import CommitList from './CommitList.svelte';
import DiffViewport from './DiffViewport.svelte';
import { errMessage } from '$lib/errmsg.js';

let {
  /** Session id from /api/v1/state. */
  sessionId,
  /** Persisted layout choice; the shell may override it. */
  view = 'unified' as 'unified' | 'split',
} = $props();

/** How many per-file /hunks requests are in flight at once. Enough to be fast on a
 *  20-file working tree, low enough not to stampede git on a 500-file one. */
const HUNK_CONCURRENCY = 5;

let repos = $state<import('./api.js').RepoCommits[]>([]);
let sel = $state<{ repo: string; sha: string } | null>(null);
let files = $state<import('./api.js').DetailFile[]>([]);
let loadingList = $state(true);
let loadingDetail = $state(false);
let listError = $state<string | null>(null);
let detailError = $state<string | null>(null);
let banner = $state<string | null>(null);

/** file → the /hunks payload, or a per-file failure. */
const hunkState = new SvelteMap<string, FileHunks | { error: string }>([]);
const busyFiles = new SvelteSet([] as string[]);
const collapsed = new SvelteSet([] as string[]);

// Every async result is stamped with the request that asked for it. A slower earlier
// response must never overwrite a faster later one — the classic way a diff pane ends
// up showing one commit's files under another commit's header.
let detailToken = 0;
/*
 * The same stamp for the COMMIT LIST, which did not have one — and needs it more,
 * because its result decides what gets fetched next.
 *
 * Switching sessions on the rail while `/commits` is in flight re-runs the effect
 * below and starts a second load. The first one then lands anyway, writes the OLD
 * session's repos into `repos`, and calls `select()` with a repo from that list —
 * which reads the CURRENT `sessionId`. The request that goes out is therefore one
 * session's id crossed with another session's repo, and the daemon answers exactly
 * what it should: 400 `unknown repo or no worktree`.
 */
let listToken = 0;

const isUncommitted = $derived(!!sel && sel.sha === 'uncommitted');

/** The selected repo's entry in the commits payload. */
const selRepo = $derived.by(() => {
  const s = sel;
  return s ? (repos.find((r) => r.repo === s.repo) ?? null) : null;
});
const selCommit = $derived.by(() => {
  const s = sel;
  const r = selRepo;
  if (!s || !r || isUncommitted) return null;
  return r.commits.find((c) => c.sha === s.sha) ?? null;
});

const totals = $derived({
  commits: repos.reduce((n, r) => n + (r.commits ? r.commits.length : 0), 0),
  unc: repos.reduce((n, r) => n + ((r.uncommitted && r.uncommitted.fileCount) || 0), 0),
});

/* ---------------- loading ---------------- */

async function loadCommits({ keepSelection = true } = {}) {
  const token = ++listToken;
  loadingList = true;
  listError = null;
  try {
    const data = await fetchCommits(sessionId);
    // A newer load (or a session switch) already superseded this one. Returning
    // BEFORE `repos` is written is the whole point: everything downstream —
    // `select()`, the branch bar, the repo chips — reads from it.
    if (token !== listToken) return;
    repos = data.repos || [];
    const s = sel;
    const survives = !!(
      keepSelection &&
      s &&
      repos.some(
        (r) =>
          r.repo === s.repo &&
          (s.sha === 'uncommitted' ? r.uncommitted.fileCount > 0 : r.commits.some((c) => c.sha === s.sha)),
      )
    );
    if (!survives) {
      // Same default as public/app.js: the newest commit if there is one, otherwise
      // whatever uncommitted entry exists.
      const withCommits = repos.find((r) => r.commits && r.commits.length);
      const withUnc = repos.find((r) => r.uncommitted && r.uncommitted.fileCount);
      if (withCommits) select(withCommits.repo, withCommits.commits[0].sha);
      else if (withUnc) select(withUnc.repo, 'uncommitted');
      else {
        sel = null;
        files = [];
      }
    }
  } catch (e) {
    if (token !== listToken) return; // a stale failure is not this session's problem
    listError = errMessage(e);
  } finally {
    // Only the load that is still current owns the spinner; a stale one clearing it
    // would say "loaded" while the real request is still out.
    if (token === listToken) loadingList = false;
  }
}

/** @param {string} repo @param {string} sha */
async function select(repo: string, sha: string) {
  sel = { repo, sha };
  const token = ++detailToken;
  files = [];
  hunkState.clear();
  collapsed.clear();
  detailError = null;
  banner = null;
  loadingDetail = true;
  try {
    const res = await fetchCommitDetail(sessionId, repo, sha);
    if (token !== detailToken) return;
    files = res.files || [];
    loadingDetail = false;
    // Skip the rename summary lines: there is no such path on disk, so /hunks would
    // spend a git call per rename to answer "no diff".
    if (sha === 'uncommitted') {
      await loadAllHunks(
        repo,
        files.map((f) => f.file).filter((f) => !isRenameSummaryPath(f)),
        token,
      );
    }
  } catch (e) {
    if (token !== detailToken) return;
    detailError = errMessage(e);
    loadingDetail = false;
  }
}

/**
 * Fetch both sides of every working file, a few at a time.
 */
async function loadAllHunks(repo: string, list: string[], token: number) {
  let next = 0;
  const worker = async () => {
    while (next < list.length && token === detailToken) {
      const file = list[next++];
      try {
        const h = await fetchHunks(sessionId, repo, file);
        if (token === detailToken) hunkState.set(file, h);
      } catch (e) {
        if (token === detailToken) hunkState.set(file, { error: errMessage(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HUNK_CONCURRENCY, list.length) }, worker));
}

/* ---------------- staging ---------------- */

/**
 */
async function apply(a: { op: 'stage' | 'unstage'; file: string; hunks: number[]; expect: string[] }) {
  if (!sel || !isUncommitted || busyFiles.has(a.file) || !a.hunks.length) return;
  busyFiles.add(a.file);
  banner = null;
  const token = detailToken;
  try {
    const res = await applyHunks(a.op, sessionId, {
      repo: sel.repo,
      file: a.file,
      hunks: a.hunks,
      expect: a.expect,
    });
    if (token === detailToken) hunkState.set(a.file, res);
  } catch (e) {
    banner = `${a.op === 'stage' ? 'Stage' : 'Unstage'} failed — ${errMessage(e)}`;
    // A refusal usually means the file moved under us. Re-read it so what is on screen
    // is what is on disk before the user tries again.
    try {
      const fresh = await fetchHunks(sessionId, sel.repo, a.file);
      if (token === detailToken) hunkState.set(a.file, fresh);
    } catch {
      /* the banner already says what went wrong */
    }
  } finally {
    busyFiles.delete(a.file);
  }
}

/* ---------------- the block model the viewport renders ---------------- */

const blocks = $derived.by(() => {
  const out: import('./model.js').Block[] = files.map((f) => {
    const groups: import('./model.js').Group[] = [];
    let note: import('./model.js').Note | null = null;
    let error: string | null = null;

    // The `old => new` half of a rename carries no patch on either route, so it gets
    // its explanation up front and skips the rest — otherwise it renders as a file
    // header with nothing under it, or (uncommitted) as "nothing left to stage",
    // which sounds like the user's changes went missing.
    const renameSummary = isRenameSummaryPath(f.file);

    if (renameSummary) {
      note = {
        tone: 'info',
        text: 'Rename summary line — git lists the same change again under its new path, with the patch. Stage it there.',
      };
    } else if (isUncommitted) {
      const h = hunkState.get(f.file);
      if (!h) {
        // Show the merged working-tree diff immediately; it is replaced by the split
        // staged/unstaged view the moment /hunks answers.
        if (f.parsed && f.parsed.hunks.length) {
          groups.push({
            label: 'Working tree · loading staging state…',
            side: null,
            action: null,
            hunks: f.parsed.hunks,
          });
        } else {
          note = refusal(f.parsed) || { tone: 'info', text: 'Loading…' };
        }
      } else if ('error' in h) {
        error = h.error;
        if (f.parsed && f.parsed.hunks.length) {
          groups.push({
            label: 'Working tree (staging unavailable)',
            side: null,
            action: null,
            hunks: f.parsed.hunks,
          });
        }
      } else {
        const un = h.unstaged;
        const st = h.staged;
        if (un && un.hunks.length) {
          groups.push({
            label: `Unstaged · ${un.hunks.length} hunk${un.hunks.length === 1 ? '' : 's'}${h.untracked ? ' · untracked' : ''}`,
            side: 'unstaged',
            action: 'stage',
            hunks: un.hunks,
          });
        }
        if (st && st.hunks.length) {
          groups.push({
            label: `Staged · ${st.hunks.length} hunk${st.hunks.length === 1 ? '' : 's'}`,
            side: 'staged',
            action: 'unstage',
            hunks: st.hunks,
          });
        }
        // Only surface a refusal that actually blocks the user: a side with no hunks
        // because it is binary / mode-only / a merge diff, not a side that is simply
        // empty because everything is staged.
        const why = refusal(un) || refusal(st);
        if (!groups.length) note = why || { tone: 'info', text: 'Nothing left to stage in this file.' };
        else if (why && why.tone === 'warn') note = why;
      }
    } else {
      note =
        refusal(f.parsed) ||
        (f.parsed
          ? null
          : {
              tone: 'warn',
              text: 'git listed this path in the commit summary but produced no patch for it.',
            });
      if (f.parsed && f.parsed.hunks.length) {
        groups.push({ label: '', side: null, action: null, hunks: f.parsed.hunks });
      }
    }

    return {
      file: f.file,
      status: f.status,
      added: f.added,
      deleted: f.deleted,
      collapsed: collapsed.has(f.file),
      rename:
        f.parsed && f.parsed.status === 'renamed' && f.parsed.oldPath && f.parsed.newPath
          ? `⟵ ${f.parsed.oldPath}`
          : null,
      busy: busyFiles.has(f.file),
      note,
      error,
      groups,
    };
  });
  // git's own rename detection did not fire → re-link the delete/add pair for display.
  return pairRenames(out);
});

const allCollapsed = $derived(files.length > 0 && collapsed.size === files.length);

function toggleAll() {
  if (allCollapsed) collapsed.clear();
  else for (const f of files) collapsed.add(f.file);
}

/** @param {string} file */
function toggleFile(file: string) {
  if (collapsed.has(file)) collapsed.delete(file);
  else collapsed.add(file);
}

const shown = $derived({
  added: files.reduce((n, f) => n + (f.added || 0), 0),
  deleted: files.reduce((n, f) => n + (f.deleted || 0), 0),
});

// Re-entry point for the shell: changing sessionId reloads everything.
$effect(() => {
  const id = sessionId;
  sel = null;
  files = [];
  hunkState.clear();
  detailToken++;
  // Bumped here as well as inside loadCommits, for the case where there is no new
  // load to bump it: switching to nothing must still discard the load in flight.
  listToken++;
  repos = [];
  if (id) loadCommits({ keepSelection: false });
});
</script>

<div class="changes">
  <div class="branchbar">
    <!-- Falls back to the first repo's branch: with nothing selected (no commits, clean
         tree) there is still a branch, and a blank heading reads like a failed load. -->
    <span class="br">{(selRepo || repos[0] || { branch: '' }).branch}</span>
    <span class="chip"><span class="cdot b"></span>{totals.commits} commit{totals.commits === 1 ? '' : 's'} vs {(repos[0] && repos[0].defaultBranch) || 'default'}</span>
    {#if totals.unc}<span class="chip"><span class="cdot a"></span>{totals.unc} uncommitted</span>{/if}
    {#each repos as r (r.repo)}
      <span class="chip">⎇ {r.repo}{r.commits && r.commits.length ? ` · ${r.commits.length}` : ''}</span>
    {/each}
    <span class="spacer"></span>

    <div class="seg" role="group" aria-label="Diff layout">
      <button class="segbtn" class:on={view === 'unified'} aria-pressed={view === 'unified'} onclick={() => { view = 'unified'; }}>Unified</button>
      <button class="segbtn" class:on={view === 'split'} aria-pressed={view === 'split'} onclick={() => { view = 'split'; }}>Side&#8209;by&#8209;side</button>
    </div>
    <span class="refresh" use:activatable={() => { const s = sel; loadCommits().then(() => { if (s) select(s.repo, s.sha); }); }} title="Reload commits and the open diff">⟳ Refresh</span>
  </div>

  {#if banner}
    <div class="banner" role="alert">
      <span>{banner}</span>
      <button class="btn xs ghost" onclick={() => { banner = null; }} aria-label="Dismiss">✕</button>
    </div>
  {/if}

  <div class="commit-cols">
    {#if loadingList}
      <div class="commit-list"><div class="chsub clean">Loading commits…</div></div>
    {:else if listError}
      <div class="commit-list"><div class="chsub clean err">{listError}</div></div>
    {:else}
      <CommitList {repos} {sel} onselect={select} />
    {/if}

    <div class="commit-detail">
      {#if !sel}
        <div class="diff-empty">Select a commit to view its changes.</div>
      {:else}
        <div class="dhd">
          <h3>{isUncommitted ? 'Uncommitted changes' : (selCommit ? selCommit.subject : sel.sha)}</h3>
          <div class="dmeta">
            {#if isUncommitted}
              <span>{sel.repo} · working tree</span>
            {:else}
              <span class="sha">{sel.sha.slice(0, 10)}</span>
              <span>{selCommit ? selCommit.author : ''}</span>
              <span>{selCommit ? selCommit.when : ''}</span>
            {/if}
            <span>{files.length} file{files.length === 1 ? '' : 's'}</span>
            <span class="stat">
              {#if shown.added}<span class="add">+{shown.added}</span>{/if}
              {#if shown.deleted}<span class="del">−{shown.deleted}</span>{/if}
            </span>
            {#if files.length}
              <button class="btn xs ghost collapse" onclick={toggleAll}>{allCollapsed ? 'Expand all' : 'Collapse all'}</button>
            {/if}
          </div>
        </div>

        {#if loadingDetail}
          <div class="diff-empty">Loading…</div>
        {:else if detailError}
          <div class="diff-empty err">{detailError}</div>
        {:else if !files.length}
          <div class="diff-empty">{isUncommitted ? 'Working tree is clean — nothing to review.' : 'This commit changed no files.'}</div>
        {:else}
          <DiffViewport {blocks} {view} stageable={isUncommitted} ontoggle={toggleFile} onapply={apply} />
        {/if}
      {/if}
    </div>
  </div>
</div>

<style>
  /* Ported from public/style.css — .changes / .branchbar / .commit-cols / .dhd / .dmeta. */
  .changes { flex:1; min-height:0; display:flex; flex-direction:column; background:var(--bg); }

  .branchbar { display:flex; align-items:center; gap:9px; flex-wrap:wrap; padding:9px 14px; border-bottom:1px solid var(--border); background:var(--panel); flex:none; }
  .branchbar .br { font-family:var(--mono); font-size:13px; font-weight:700; color:var(--ink); }
  .branchbar .spacer { flex:1; }
  .cdot { width:7px; height:7px; border-radius:50%; }
  .cdot.b { background:var(--brand); } .cdot.a { background:var(--waiting); }
  .refresh { cursor:pointer; color:var(--muted); font-family:var(--mono); font-size:11.5px; }
  .refresh:hover { color:var(--brand); }

  /* segmented unified / side-by-side switch */
  .seg { display:inline-flex; border:1px solid var(--border-strong); border-radius:8px; overflow:hidden; }
  .segbtn { font-family:var(--mono); font-size:11.5px; font-weight:600; padding:4px 10px; border:0; background:var(--elevated); color:var(--muted); cursor:pointer; }
  .segbtn + .segbtn { border-left:1px solid var(--border-strong); }
  .segbtn:hover { color:var(--ink); }
  .segbtn.on { background:var(--brand); color:var(--brand-ink); }

  .banner { flex:none; display:flex; align-items:center; gap:10px; padding:7px 14px; background:var(--del-bg); color:var(--del); border-bottom:1px solid var(--border); font-family:var(--mono); font-size:12.5px; }
  .banner span { flex:1; }

  .commit-cols { display:grid; grid-template-columns:300px 1fr; min-height:0; flex:1; }
  .commit-list { border-right:1px solid var(--border); overflow:auto; background:var(--panel); }
  .commit-detail { overflow:hidden; background:var(--bg); display:flex; flex-direction:column; min-width:0; min-height:0; }

  .chsub { font-family:var(--mono); font-size:10.5px; color:var(--faint); padding:9px 12px 5px; }
  .chsub.clean { text-transform:none; letter-spacing:0; }
  .chsub.err, .diff-empty.err { color:var(--del); }

  .dhd { padding:13px 16px; border-bottom:1px solid var(--border); background:var(--panel); flex:none; }
  .dhd h3 { margin:0 0 5px; font-size:15px; font-weight:650; }
  .dmeta { font-family:var(--mono); font-size:11.5px; color:var(--muted); display:flex; gap:12px; flex-wrap:wrap; align-items:center; }
  .dmeta .sha { color:var(--brand); }
  .dmeta .stat { display:inline-flex; gap:6px; }
  .dmeta .collapse { margin-left:auto; }
  .add { color:var(--add); } .del { color:var(--del); }

  .diff-empty { color:var(--faint); font-family:var(--mono); font-size:13px; padding:16px; }

  @media (max-width: 820px) {
    .commit-cols { grid-template-columns:1fr; grid-template-rows:minmax(120px, 30%) 1fr; }
    .commit-list { border-right:0; border-bottom:1px solid var(--border); }
  }
</style>
