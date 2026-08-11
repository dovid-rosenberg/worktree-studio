<script lang="ts">
// Transcript search.
//
// Three things shape this component more than anything else:
//
//  1. The corpus is live. Sessions append while you type, and the index only catches
//     up on a Stop hook — so results carry an "as of" honesty line, and a scoped
//     search leans on the server re-indexing that session before answering.
//  2. FTS5's MATCH is a query language. `ftsTerms` mirrors the server's tokenizer so
//     the panel can show what will actually be matched, and can tell the difference
//     between "no results" and "your query reduced to nothing".
//  3. `total` from the API is the length of the returned page, not a corpus count.
//     A full page therefore reads "first N", never "N results" — the difference
//     matters when you are deciding whether to narrow a query.
import {
  searchTranscripts,
  listSessions,
  transcriptStatus,
  reindex,
  ftsTerms,
  highlightTerms,
} from './api.js';
import SearchHit from './SearchHit.svelte';
import IndexStatus from './IndexStatus.svelte';

import type { Hit, StateSession } from './types';
import { errMessage, isAbort } from '$lib/errmsg.js';

/**
 * @type {{
 *   sessionId?: string|null,
 *   sessions?: StateSession[]|null,
 *   autofocus?: boolean,
 *   limit?: number,
 *   onopen?: (hit: Hit) => void,
 *   onclose?: (() => void)|null,
 * }}
 */
let {
  /** Lock the panel to one session (mounted inside a session view). */
  sessionId = null,
  /** The shell owns session state; pass it in to avoid a second /api/state fetch. */
  sessions = null,
  autofocus = true,
  limit = 30,
  /** Called with the hit the user chose — the shell decides what "open" means. */
  onopen = () => {},
  /** Called when the user asks to leave (Escape on an empty query). */
  onclose = null,
}: {
  sessionId?: string | null;
  sessions?: StateSession[] | null;
  autofocus?: boolean;
  limit?: number;
  onopen?: (hit: Hit) => void;
  onclose?: (() => void) | null;
} = $props();

let q = $state('');
// Deliberately the INITIAL value: `scope` is user-owned state after mount, and a
// derived would fight the scope picker on every keystroke.
// svelte-ignore state_referenced_locally
let scope = $state(sessionId || '');
let role = $state('');
let order = $state('rank');

let hits: Hit[] = $state([]);
let backend: string | null = $state(null);
let loading = $state(false);
let error: string | null = $state(null);
let ran = $state(false);
let ranQuery = $state('');
let ranAt = $state(0);
let selected = $state(-1);

let ownSessions: StateSession[] = $state([]);
let status: import('./types.js').TranscriptStatus | null = $state(null);
let statusError: string | null = $state(null);
let indexing = $state(false);

let inputEl: HTMLInputElement | null = $state(null);
let listEl: HTMLElement | null = $state(null);

const locked = $derived(!!sessionId);
const sessionList = $derived(sessions ?? ownSessions);
const terms = $derived(ftsTerms(q));
// Input that survives the tokenizer as nothing at all: a lone quote, `***`, `--`.
// The server answers these with an empty list and no explanation.
const degenerate = $derived(q.trim().length > 0 && terms.length === 0);
const capped = $derived(hits.length >= limit);
const scopedSession = $derived(sessionList.find((s) => s.id === scope) || null);

/** @type {ReturnType<typeof setTimeout>|undefined} */
let timer: ReturnType<typeof setTimeout> | undefined;
let ctrl: AbortController | null = null;
let seq = 0;

/** @param {unknown} e */

async function refreshStatus() {
  try {
    status = await transcriptStatus();
  } catch (e) {
    statusError = errMessage(e);
  }
}

$effect(() => {
  refreshStatus();
  if (!sessions)
    listSessions()
      .then((s) => {
        ownSessions = s;
      })
      .catch(() => {});
});

$effect(() => {
  if (autofocus && inputEl) inputEl.focus();
});

// Debounced auto-search. Reading the four inputs here is what makes this the
// dependency list; `run()` fires from a timer, so its own reads are untracked and
// cannot feed back into this effect.
$effect(() => {
  q;
  scope;
  role;
  order;
  clearTimeout(timer);
  timer = setTimeout(run, 180);
  return () => clearTimeout(timer);
});

async function run() {
  clearTimeout(timer);
  const query = q.trim();
  // Abort rather than ignore: a slow query for "m" is wasted work once "migration"
  // is typed, and letting it land would repaint the list with the wrong results.
  ctrl?.abort();
  ctrl = null;

  if (!query || ftsTerms(query).length === 0) {
    seq++;
    hits = [];
    ran = !!query;
    ranQuery = query;
    loading = false;
    error = null;
    selected = -1;
    return;
  }

  ctrl = new AbortController();
  const my = ++seq;
  loading = true;
  error = null;
  try {
    const res = await searchTranscripts(
      { q: query, session: scope || null, role: role || null, order, limit },
      ctrl.signal,
    );
    if (my !== seq) return;
    hits = Array.isArray(res.hits) ? res.hits : [];
    backend = res.backend || null;
    ran = true;
    ranQuery = query;
    ranAt = Date.now();
    selected = -1;
  } catch (e) {
    if (isAbort(e)) return;
    if (my !== seq) return;
    error = errMessage(e);
    hits = [];
    ran = true;
    ranQuery = query;
  } finally {
    if (my === seq) loading = false;
  }
}

/** @param {{ session?: string|null, full?: boolean }} opts */
async function doReindex(opts: { session?: string | null; full?: boolean }) {
  indexing = true;
  statusError = null;
  try {
    await reindex(opts);
    await refreshStatus();
    if (q.trim()) await run();
  } catch (e) {
    statusError = errMessage(e);
  } finally {
    indexing = false;
  }
}

// ---- keyboard ----
// Every hit is a real tab stop (activatable sets tabindex=0), so Tab reaches any
// result. Arrows are the fast path on top of that, not a replacement for it.
const hitEls = () =>
  listEl ? /** @type {HTMLElement[]} */ ([...listEl.querySelectorAll<HTMLElement>('[data-hit]')]) : [];

/** @param {number} i */
function focusHit(i: number) {
  const els = hitEls();
  if (!els.length) return false;
  const n = Math.max(0, Math.min(els.length - 1, i));
  selected = n;
  els[n].focus();
  return true;
}

/** @param {KeyboardEvent} e */
function onInputKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    if (focusHit(0)) e.preventDefault();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (hits.length && !loading) onopen(hits[0]);
    else run();
    return;
  }
  if (e.key === 'Escape') {
    if (q) {
      q = '';
      e.preventDefault();
      e.stopPropagation();
    } else if (onclose) {
      onclose();
      e.preventDefault();
      e.stopPropagation();
    }
  }
}

/** @param {KeyboardEvent} e */
function onListKey(e: KeyboardEvent) {
  const els = hitEls();
  if (!els.length) return;
  const at = els.indexOf(document.activeElement as HTMLElement);
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      focusHit(at + 1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      if (at <= 0) {
        selected = -1;
        inputEl?.focus();
      } else focusHit(at - 1);
      break;
    case 'Home':
      e.preventDefault();
      focusHit(0);
      break;
    case 'End':
      e.preventDefault();
      focusHit(els.length - 1);
      break;
    // Consumed here, so an enclosing overlay does not also read it as "close me".
    case 'Escape':
      e.preventDefault();
      e.stopPropagation();
      selected = -1;
      inputEl?.focus();
      break;
    default:
      break;
  }
}
</script>

<section class="search" aria-label="Transcript search">
  <div class="qrow">
    <label class="qwrap">
      <span class="vh">Search transcripts</span>
      <input
        bind:this={inputEl}
        bind:value={q}
        class="qinput"
        type="search"
        autocomplete="off"
        spellcheck="false"
        placeholder={locked ? 'Search this session…' : 'Search every Studio transcript…'}
        aria-describedby="search-meta"
        onkeydown={onInputKey}
      />
    </label>
    {#if loading}<span class="spin" aria-hidden="true"></span>{/if}
  </div>

  <!-- One filter row above everything it scopes; never per-result controls. -->
  <div class="filters">
    {#if !locked}
      <label class="f">
        <span>Scope</span>
        <select class="mini-select" bind:value={scope}>
          <option value="">All sessions</option>
          {#each sessionList as s (s.id)}
            <option value={s.id}>{s.title}</option>
          {/each}
        </select>
      </label>
    {/if}
    <label class="f">
      <span>Role</span>
      <select class="mini-select" bind:value={role}>
        <option value="">Anyone</option>
        <option value="user">You</option>
        <option value="assistant">Claude</option>
      </select>
    </label>
    <label class="f">
      <span>Order</span>
      <select class="mini-select" bind:value={order} disabled={backend === 'sqlite-like'}>
        <option value="rank">Relevance</option>
        <option value="recent">Newest</option>
      </select>
    </label>
    {#if scope && !locked}
      <button type="button" class="btn ghost xs" onclick={() => { scope = ''; }}>clear scope</button>
    {/if}
  </div>

  {#if status && (!status.ready || !status.messages || status.fts5 === false)}
    <div class="banner">
      <IndexStatus {status} busy={indexing} error={statusError} onreindex={doReindex} />
    </div>
  {/if}

  <p class="meta" id="search-meta">
    {#if error}
      <span class="bad">{error}</span>
    {:else if degenerate}
      <span class="bad">Nothing to match</span> — that query reduces to no searchable terms.
    {:else if !q.trim()}
      Searches every message in {status?.ready ? `${status.sessions} indexed ` : ''}Studio-managed session{status?.sessions === 1 ? '' : 's'}.
      Terms are matched as whole phrases and ANDed together.
    {:else if loading && !hits.length}
      Searching…
    {:else if ran && !hits.length}
      <span>No matches for {#each terms as t, i (i)}<code>{t}</code>{#if i < terms.length - 1}<span class="and"> and </span>{/if}{/each}{#if scopedSession} in {scopedSession.title}{/if}.</span>
    {:else if ran}
      {#if capped}First {hits.length}{:else}{hits.length}{/if}
      {hits.length === 1 ? 'match' : 'matches'}
      {#if terms.length > 1}for {#each terms as t, i (i)}<code>{t}</code>{#if i < terms.length - 1}<span class="and"> and </span>{/if}{/each}{/if}
      {#if scopedSession}in {scopedSession.title}{/if}
      {#if capped}<span class="hint">— narrow the query to see the rest</span>{/if}
    {/if}
  </p>

  <!-- A results list, not a widget: every row is individually focusable, and this
       handler only adds arrow-key movement between rows that Tab already reaches. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="results"
    bind:this={listEl}
    role="list"
    aria-busy={loading}
    class:stale={loading && hits.length > 0}
    onkeydown={onListKey}
  >
    {#each hits as hit, i (hit.uuid + hit.sessionId)}
      <SearchHit
        {hit}
        terms={highlightTerms(ranQuery)}
        showSession={!locked}
        selected={selected === i}
        onopen={(h: Hit) => onopen(h)}
        onscope={locked ? null : (id: string) => { scope = id; inputEl?.focus(); }}
      />
    {/each}

    {#if ran && !hits.length && !error && !degenerate}
      <div class="empty">
        <p>Nothing matched.</p>
        <ul>
          {#if scope}<li>The search is scoped to one session — <button type="button" class="linkish" onclick={() => { scope = ''; }}>search all sessions</button>.</li>{/if}
          {#if role}<li>Only <b>{role === 'user' ? 'your' : "Claude's"}</b> messages are being searched — <button type="button" class="linkish" onclick={() => { role = ''; }}>include both</button>.</li>{/if}
          {#if terms.length > 1}<li>All {terms.length} terms have to appear in the same message. Try just <button type="button" class="linkish" onclick={() => { q = terms[0]; }}>{terms[0]}</button>.</li>{/if}
          <li>Only sessions Studio manages are indexed — the rest of <code>~/.claude/projects</code> is not.</li>
        </ul>
      </div>
    {/if}
  </div>

  <footer class="foot">
    <IndexStatus {status} compact busy={indexing} onreindex={doReindex} />
    {#if ran && hits.length}
      <span class="asof">
        results as of {new Date(ranAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
        — a session indexes when its turn ends, so a reply still being written is not searchable yet
      </span>
    {/if}
  </footer>
</section>

<style>
  .search { display: flex; flex-direction: column; min-height: 0; }

  .qrow { position: relative; display: flex; align-items: center; }
  .qwrap { flex: 1; display: block; }
  .vh {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }
  /* The command-palette input from public/style.css: borderless, big, a brand underline
     on focus standing in for the suppressed outline. */
  .qinput {
    width: 100%; border: 0; border-bottom: 1px solid var(--border);
    background: transparent; color: var(--ink); font-size: 16px;
    padding: 15px 18px; outline: none; font-family: var(--sans);
  }
  .qinput:focus-visible { outline: none; border-bottom-color: var(--brand); }
  .qinput::-webkit-search-cancel-button { filter: grayscale(1); opacity: .5; }

  .spin {
    position: absolute; right: 16px; width: 13px; height: 13px; border-radius: 50%;
    border: 2px solid var(--border-strong); border-top-color: var(--brand);
    animation: spin .7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spin { animation: none; border-top-color: var(--border-strong); } }

  .filters {
    display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
    padding: 9px 16px; border-bottom: 1px solid var(--border); background: var(--elevated);
  }
  .f { display: inline-flex; align-items: center; gap: 6px; }
  .f > span {
    font-family: var(--mono); font-size: 9.5px; letter-spacing: .08em;
    text-transform: uppercase; color: var(--faint);
  }

  .banner { padding: 12px 16px 0; }

  .meta {
    margin: 0; padding: 9px 16px;
    font-family: var(--mono); font-size: 11px; color: var(--muted); line-height: 1.5;
  }
  .meta code { color: var(--ink); background: var(--elevated); border-radius: 4px; padding: 1px 5px; }
  .meta .and { color: var(--faint); }
  .meta .hint, .meta .bad { color: var(--faint); }
  .meta .bad { color: var(--waiting); font-weight: 600; }

  .results { flex: 1; min-height: 0; overflow-y: auto; }
  /* Hold the previous render while a refetch is in flight — a skeleton here would
     flash the whole list away on every keystroke. */
  .results.stale { opacity: .55; }

  .empty { padding: 18px 16px; color: var(--muted); font-size: 13px; }
  .empty p { margin: 0 0 8px; }
  .empty ul { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 5px; }
  .empty li { font-size: 12.5px; line-height: 1.5; }
  .empty code { font-family: var(--mono); font-size: 11.5px; color: var(--faint); }
  .linkish {
    background: none; border: 0; padding: 0; color: var(--brand);
    font: inherit; cursor: pointer; text-decoration: underline;
  }

  .foot {
    flex: none; display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
    padding: 9px 16px; border-top: 1px solid var(--border); background: var(--panel);
  }
  .asof { font-family: var(--mono); font-size: 10px; color: var(--faint); flex: 1; min-width: 200px; }
</style>
