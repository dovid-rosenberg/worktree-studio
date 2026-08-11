<script lang="ts">
// What the search index is currently capable of, said plainly.
//
// Search runs over a corpus that is still being appended to, and the index behind it
// has three genuinely different capability levels (sqlite-fts5 / sqlite-like /
// file-scan) plus a cold state where it is simply empty. Every one of those changes
// what an empty result MEANS, so none of them may be silent.
import { exactTokens } from './format.js';

/**
 * @type {{
 *   status?: import('./types.js').TranscriptStatus|null,
 *   busy?: boolean,
 *   error?: string|null,
 *   onreindex?: ((opts: { session?: string|null, full?: boolean }) => void)|null,
 *   compact?: boolean,
 * }}
 */
let {
  status = null,
  busy = false,
  error = null,
  onreindex = null,
  /** Footer mode: one quiet line. Otherwise a banner, but only when something is wrong. */
  compact = false,
} = $props();

const cold = $derived(!!status?.ready && !status.messages);
const degraded = $derived(!!status && (!status.ready || status.fts5 === false));
const level = $derived(!status ? null : !status.ready ? 'warn' : cold ? 'cold' : degraded ? 'warn' : 'ok');

const backendLabel = $derived(
  !status
    ? ''
    : status.backend === 'sqlite-fts5'
      ? 'full-text index'
      : status.backend === 'sqlite-like'
        ? 'substring index (no FTS5)'
        : 'file scan (no index)',
);

const message = $derived(
  !status
    ? ''
    : !status.ready
      ? `No search index: ${status.error || 'sqlite unavailable'}. Every query falls back to scanning transcript files — slower, substring-only, and it cannot rank by relevance.`
      : cold
        ? 'The index is empty. Sessions are indexed when Claude finishes a turn, so a freshly started daemon has nothing to search yet.'
        : status.fts5 === false
          ? 'FTS5 is not available in this sqlite build. Queries fall back to substring matching: no ranking, no stemming, and multi-word queries match literally.'
          : '',
);
</script>

{#if status && compact}
  <p class="ixline">
    <span class="ok-dot" class:warn={level !== 'ok'}></span>
    {backendLabel}
    {#if status.ready}
      · {status.sessions} {status.sessions === 1 ? 'session' : 'sessions'}
      · {exactTokens(status.messages)} messages indexed
    {/if}
    {#if onreindex}
      <button type="button" class="btn ghost xs" disabled={busy} onclick={() => onreindex({ full: false })}>
        {busy ? 'indexing…' : 'reindex'}
      </button>
    {/if}
  </p>
{:else if status && message}
  <div class="ix {level}">
    <div class="ix-body">
      <strong>{cold ? 'Index is cold' : 'Search is degraded'}</strong>
      <p>{message}</p>
    </div>
    {#if onreindex}
      <button type="button" class="btn sm" disabled={busy} onclick={() => onreindex({ full: true })}>
        {busy ? 'Indexing…' : 'Build index now'}
      </button>
    {/if}
  </div>
{/if}

{#if error}
  <div class="ix warn"><div class="ix-body"><strong>Reindex failed</strong><p>{error}</p></div></div>
{/if}

<style>
  .ix {
    display: flex; align-items: center; gap: 14px;
    padding: 11px 14px; border-radius: 10px;
    border: 1px solid var(--border-strong);
    background: var(--elevated);
    box-shadow: inset 3px 0 0 var(--waiting);
  }
  .ix.cold { box-shadow: inset 3px 0 0 var(--idle); }
  .ix-body { flex: 1; min-width: 0; }
  .ix-body strong { display: block; font-size: 12.5px; margin-bottom: 3px; }
  .ix-body p { margin: 0; font-size: 12px; line-height: 1.5; color: var(--muted); }
  .ix .btn { flex: none; }

  .ixline {
    margin: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    font-family: var(--mono); font-size: 10.5px; color: var(--faint);
  }
  .ok-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--done); flex: none; }
  .ok-dot.warn { background: var(--waiting); }
</style>
