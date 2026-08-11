<script lang="ts">
/*
 * Pick a folder on the machine the daemon runs on.
 *
 * A browser cannot do this. `<input type="file" webkitdirectory>` uploads a directory's
 * contents and hands back relative names; `showDirectoryPicker()` returns a handle with
 * no path on it. Both answer "which files" when the question is "which path" — so the
 * daemon lists directories (server/browse.ts) and this walks that listing.
 *
 * IT SHOWS WHICH CHILDREN ARE REPOS, which is the whole judgement being made. A base
 * directory is not a folder you like, it is a folder whose descendants are git
 * checkouts, and the difference between `~/code` and `~/code/worktree-studio` is
 * invisible until something says "12 repos in here" versus "this IS a repo". Typing a
 * path into a text field gave no feedback at all until you saved and the rail either
 * filled or did not.
 */
import Modal from '$lib/components/Modal.svelte';
import { api } from '$lib/api.js';
import { errMessage } from '$lib/errmsg.js';

let {
  start = '',
  onpick,
  onclose,
}: {
  /** Where to open. Empty starts at the home directory, which the server decides. */
  start?: string;
  onpick: (path: string) => void;
  onclose: () => void;
} = $props();

interface Entry {
  name: string;
  path: string;
  repo: boolean;
}

let cwd = $state('');
let parent = $state<string | null>(null);
let entries = $state<Entry[]>([]);
let repoCount = $state(0);
let loading = $state(true);
let error = $state('');
/** The path typed into the crumb bar — kept separate so editing it does not navigate. */
let typed = $state('');

async function load(p: string) {
  loading = true;
  error = '';
  try {
    const r = await api('GET', `/api/v1/fs/dirs?path=${encodeURIComponent(p)}`);
    cwd = r.path || '';
    typed = cwd;
    parent = r.parent ?? null;
    entries = r.entries || [];
    repoCount = r.repoCount || 0;
    // The server answers with the home directory when a path is unreadable rather than
    // going blank — so this is a note about where you are, not a dead end.
    if (r.error) error = r.error;
  } catch (e) {
    error = errMessage(e);
  } finally {
    loading = false;
  }
}

// `start` is read once, on open: this modal is created when it is shown, so that IS
// "on open", and reacting to it would yank the listing back while someone browses.
// svelte-ignore state_referenced_locally
load(start);
</script>

<Modal label="Choose a folder" onclose={onclose}>
  <div class="modal-head">
    <b>Choose a folder</b>
    <span class="spacer"></span>
    <button class="btn ghost" title="Close" aria-label="Close" onclick={onclose}>✕</button>
  </div>

  <div class="crumbs">
    <button
      class="btn xs"
      disabled={!parent || loading}
      title="Up one level"
      aria-label="Up one level"
      onclick={() => parent && load(parent)}
    >↑</button>
    <!-- Editable, because typing `~/code` is faster than eight clicks when you already
         know where you are going. Enter navigates; it does not choose. -->
    <input
      class="pathbox"
      bind:value={typed}
      aria-label="Folder path"
      spellcheck="false"
      onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); load(typed); } }}
    />
  </div>

  <div class="modal-body">
    {#if error}<div class="note err">{error}</div>{/if}

    <!--
      The verdict on the folder you are STANDING IN, stated before the list.
      This is the sentence that decides the answer: a base directory is one whose
      children are repos.
    -->
    <div class="verdict" class:good={repoCount > 0}>
      {#if loading}
        Reading…
      {:else if repoCount}
        {repoCount} git {repoCount === 1 ? 'repo' : 'repos'} directly inside — a good base directory.
      {:else}
        No git repos directly inside. Studio scans a base directory for checkouts, so pick
        the folder that <em>contains</em> your repos.
      {/if}
    </div>

    {#if !loading && !entries.length}
      <div class="dirlist"><div class="note">Nothing to open here.</div></div>
    {:else}
      <!-- A real list of real buttons. `role="listitem"` on a <button> is invalid — it
           replaces the button's own role, so the thing you can press stops announcing
           that it can be pressed. -->
      <ul class="dirlist">
        {#each entries as e (e.path)}
          <li>
            <button class="direntry" onclick={() => load(e.path)} title={e.path}>
              <span class="g" aria-hidden="true">{e.repo ? '⎇' : '▸'}</span>
              <span class="nm">{e.name}</span>
              {#if e.repo}<span class="tag">git repo</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="modal-foot">
    <span class="here" title={cwd}>{cwd}</span>
    <span class="spacer"></span>
    <button class="btn" onclick={onclose}>Cancel</button>
    <button class="btn primary" disabled={!cwd || loading} onclick={() => onpick(cwd)}>Use this folder</button>
  </div>
</Modal>

<style>
  /* Same chrome as every other modal. Restated rather than shared because Svelte scopes
     styles per component — DialogHost, SettingsModal and IntakeModal each carry their own
     copy of these two rules for the same reason. */
  .modal-head { display:flex; align-items:center; gap:9px; padding:14px 16px; border-bottom:1px solid var(--border); font-size:15px; }
  .modal-body { padding:14px 16px; }

  .crumbs { display:flex; align-items:center; gap:7px; padding:10px 16px; border-bottom:1px solid var(--border); }
  .pathbox { flex:1; min-width:0; font-family:var(--mono); font-size:12px; padding:5px 8px;
             border:1px solid var(--border); border-radius:7px; background:var(--bg); color:var(--ink); }

  .verdict { font-size:12.5px; line-height:1.5; color:var(--muted); padding:8px 10px; margin-bottom:8px;
             border-left:2px solid var(--border-strong); background:var(--elevated); border-radius:0 7px 7px 0; }
  .verdict.good { border-left-color:var(--done); color:var(--ink); }
  .verdict em { font-style:normal; font-weight:650; }

  /* A fixed height, so the modal does not resize as you walk into folders of different
     sizes — the Use button must stay under the cursor. */
  .dirlist { height:46vh; min-height:200px; overflow-y:auto; border:1px solid var(--border);
             border-radius:9px; padding:4px; display:flex; flex-direction:column; gap:1px;
             margin:0; list-style:none; }
  .direntry { display:flex; align-items:center; gap:9px; width:100%; font:inherit; font-size:13px;
              background:none; border:0; border-radius:7px; padding:6px 8px; color:var(--ink);
              text-align:left; cursor:pointer; }
  .direntry:hover { background:var(--elevated); }
  .direntry .g { width:14px; text-align:center; color:var(--faint); font-size:11px; }
  .direntry .nm { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .direntry .tag { flex:none; font-family:var(--mono); font-size:10px; color:var(--done); }

  .modal-foot { display:flex; align-items:center; gap:8px; padding:11px 16px; border-top:1px solid var(--border); }
  .modal-foot .here { font-family:var(--mono); font-size:11px; color:var(--faint);
                      overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:46%; }
  .spacer { flex:1; }
  .note { padding:9px 10px; font-size:12.5px; color:var(--muted); }
  .note.err { color:var(--del); }
</style>
