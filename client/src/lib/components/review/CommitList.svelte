<script lang="ts">
  import type { Commit } from './api';
  /*
   * Left column: every uncommitted entry (one per repo with working changes) pinned at
   * the top, then each repo's commits newest first under a repo header. Order matches
   * public/app.js's renderCommitList so the two UIs read the same during the port.
   *
   * Keyboard model is a vertical toolbar with a roving tabindex: Tab enters the list once
   * and leaves it once, ↑/↓ move between rows. A branch with forty commits would otherwise
   * be forty tab stops between the diff pane and everything after it.
   */
  let {
    /** @type {import('./api.js').RepoCommits[]} */
    repos = [],
    /** @type {{ repo:string, sha:string }|null} */
    sel = null,
    /** @type {(repo:string, sha:string) => void} */
    onselect = () => {},
  } = $props();

  let list = $state<HTMLElement|null>(null);


  type Entry =
    | { t: 'hd'; key: string; label: string }
    | { t: 'unc'; key: string; repo: string; u: { fileCount: number; added: number; deleted: number } }
    | { t: 'commit'; key: string; repo: string; c: Commit };
  const rendered = $derived.by(() => {
        const out: Entry[] = [];
    const withUnc = repos.filter((r) => r.uncommitted && r.uncommitted.fileCount > 0);
    if (withUnc.length) {
      out.push({ t: 'hd', key: 'hd:unc', label: 'Uncommitted' });
      for (const r of withUnc) out.push({ t: 'unc', key: `${r.repo}\u0000uncommitted`, repo: r.repo, u: r.uncommitted });
    }
    for (const r of repos) {
      if (!(r.commits && r.commits.length)) continue;
      out.push({ t: 'hd', key: `hd:${r.repo}`, label: `⎇ ${r.repo}` });
      for (const c of r.commits) out.push({ t: 'commit', key: `${r.repo}\u0000${c.sha}`, repo: r.repo, c });
    }
    return out;
  });

  // NOTE the `\u0000` escapes: the separator is a real NUL at runtime (nothing in a
  // repo name or a sha can collide with it), written as an escape so the source file
  // stays plain text. A literal NUL byte in a .svelte file makes git classify it as
  // binary, and this very panel would then render the file's own history as
  // "Binary file — no textual diff".
  const rows = $derived(rendered.filter((e) => e.t !== 'hd'));
  const selKey = $derived(sel ? `${sel.repo}\u0000${sel.sha}` : '');
  /** The one row in the tab order. Falls back to the first row so the list is always
   *  reachable, even before anything is selected. */
  const tabKey = $derived(rows.some((r) => r.key === selKey) ? selKey : (rows[0] ? rows[0].key : ''));
  const empty = $derived(rows.length === 0);
  const anyUnc = $derived(rendered.some((e) => e.t === 'unc'));

  /** ↑/↓ walk the rendered rows in DOM order, which is exactly the visual order. */
  function onKeydown(e: KeyboardEvent) {
    if (!list || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    const els = /** @type {HTMLElement[]} */ ([...list.querySelectorAll<HTMLElement>('button.crow')]);
    const i = els.indexOf((document.activeElement as HTMLElement));
    const next = els[(i < 0 ? 0 : i + (e.key === 'ArrowDown' ? 1 : -1))];
    if (!next) return;
    e.preventDefault();
    next.focus();
  }
</script>

<div
  class="commit-list"
  bind:this={list}
  onkeydown={onKeydown}
  role="toolbar"
  tabindex="-1"
  aria-orientation="vertical"
  aria-label="Commits on this branch"
>
  {#each rendered as e (e.key)}
    {#if e.t === 'hd'}
      <div class="grouphd">{e.label}</div>
    {:else if e.t === 'unc'}
      <button
        class="crow uncommitted" class:on={selKey === e.key}
        tabindex={tabKey === e.key ? 0 : -1}
        aria-pressed={selKey === e.key}
        onclick={() => onselect(e.repo, 'uncommitted')}
      >
        <span class="l1"><span class="sha">●</span><span class="subj">Uncommitted changes</span></span>
        <span class="l2">
          {e.repo} · {e.u.fileCount} file{e.u.fileCount === 1 ? '' : 's'}
          <span class="stat">
            {#if e.u.added}<span class="add">+{e.u.added}</span>{/if}
            {#if e.u.deleted}<span class="del">−{e.u.deleted}</span>{/if}
          </span>
        </span>
      </button>
    {:else}
      <button
        class="crow" class:on={selKey === e.key}
        tabindex={tabKey === e.key ? 0 : -1}
        aria-pressed={selKey === e.key}
        onclick={() => onselect(e.repo, e.c.sha)}
      >
        <span class="l1"><span class="sha">{e.c.sha.slice(0, 7)}</span><span class="subj" title={e.c.subject}>{e.c.subject}</span></span>
        <span class="l2">
          {e.c.author} · {e.c.when}
          <span class="stat">
            {#if e.c.added}<span class="add">+{e.c.added}</span>{/if}
            {#if e.c.deleted}<span class="del">−{e.c.deleted}</span>{/if}
          </span>
        </span>
      </button>
    {/if}
  {/each}

  {#if empty}
    <div class="chsub clean">No commits on this branch yet, and a clean working tree.</div>
  {:else if !anyUnc}
    <div class="chsub clean">Working tree is clean.</div>
  {/if}
</div>

<style>
  /* Ported from public/style.css — .commit-list / .grouphd / .crow / .chsub. */
  .commit-list { border-right:1px solid var(--border); overflow:auto; background:var(--panel); min-height:0; }
  .grouphd { font-family:var(--mono); font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--faint); padding:11px 13px 5px; position:sticky; top:0; background:var(--panel); z-index:1; }
  .chsub { font-family:var(--mono); font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--faint); padding:9px 12px 5px; }
  .chsub.clean { text-transform:none; letter-spacing:0; }

  .crow { display:block; width:100%; text-align:left; border:0; background:none; cursor:pointer; padding:8px 13px; border-left:2px solid transparent; border-bottom:1px solid var(--border); font-family:var(--sans); color:var(--ink); }
  .crow:hover { background:var(--elevated); }
  .crow.on { background:var(--elevated); border-left-color:var(--brand); }
  .crow .l1 { display:flex; align-items:center; gap:8px; }
  .crow .sha { font-family:var(--mono); font-size:12px; color:var(--brand); flex:none; }
  .crow .subj { color:var(--ink); font-size:13.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .crow .l2 { display:flex; align-items:center; gap:8px; margin-top:3px; font-size:11.5px; color:var(--faint); font-family:var(--mono); }
  .crow .stat { margin-left:auto; font-family:var(--mono); font-size:11.5px; white-space:nowrap; display:inline-flex; gap:6px; }
  .crow.uncommitted { border-left-color:var(--waiting); }
  .crow.uncommitted .sha { color:var(--waiting); }
  .add { color:var(--add); } .del { color:var(--del); }
</style>
