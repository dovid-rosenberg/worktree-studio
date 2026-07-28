<script lang="ts">
  import type { Tokens } from './types';
  // "Where did the money go" — one row per feature or per session, ranked by cost.
  //
  // Form: emphasis, not categorical. There is one measure here and the rows are nominal
  // (features, sessions), so shading each bar by its own size would double-encode the
  // length and burn the only free channel on information the bar already carries. Every
  // bar is one flat de-emphasis gray and the SELECTED row wears the brand hue — which
  // also makes the emphasis carry the selection state instead of inventing a second cue.
  //
  // This is dollars, straight from the server, at the only granularities it actually
  // prices. Nothing here is derived, and nothing is a token count wearing a dollar sign.
  import './viz.css';
  import { activatable } from '$lib/actions/activatable.js';
  import { usd, compactTokens, exactTokens, totalTokens } from './format.js';

  /** One ranked row: a feature or a session, with the usage the bar is drawn from. */
  export interface RankRow {
    key: string;
    label: string;
    sub?: string;
    costUsd: number | null;
    /** Usage rows come from either the session or the feature rollup, so both carry
     *  the token counts plus an optional message count. */
    usage: Tokens & { costUsd?: number | null; messages?: number };
    indexed?: boolean;
    unpriced?: string[];
  }

  let {
    rows = [], selected = null, onselect = () => {}, emptyLabel = 'Nothing indexed yet.',
  }: {
    rows?: RankRow[];
    selected?: string | null;
    onselect?: (key: string) => void;
    emptyLabel?: string;
  } = $props();

  const max = $derived(Math.max(0, ...rows.map((r) => r.costUsd || 0)));
  const total = $derived(rows.reduce((a, r) => a + (r.costUsd || 0), 0));
  // With nothing selected the top spender carries the emphasis, so the chart still has
  // a subject on first paint.
  const emphasised = $derived(selected || rows.find((r) => (r.costUsd || 0) > 0)?.key || null);
</script>

{#if !rows.length}
  <p class="none">{emptyLabel}</p>
{:else}
  <ul class="rank">
    {#each rows as r (r.key)}
      {@const on = r.key === emphasised}
      {@const width = max > 0 ? Math.max(r.costUsd ? 2 : 0, ((r.costUsd || 0) / max) * 100) : 0}
      <li>
        <div
          class="row"
          class:on
          class:unindexed={r.indexed === false}
          aria-current={r.key === selected ? 'true' : undefined}
          aria-label={`${r.label}: ${r.indexed === false ? 'not indexed' : usd(r.costUsd) || 'unpriced'}`}
          use:activatable={() => onselect(r.key)}
        >
          <div class="head">
            <span class="name">{r.label}</span>
            {#if r.sub}<span class="sub">{r.sub}</span>{/if}
            <span class="grow"></span>
            {#if r.indexed === false}
              <span class="val muted">not indexed</span>
            {:else}
              <span class="val" title={total ? `${(((r.costUsd || 0) / total) * 100).toFixed(1)}% of the total` : ''}>
                {usd(r.costUsd) ?? 'unpriced'}
              </span>
            {/if}
          </div>

          <div class="track">
            {#if r.indexed !== false && width > 0}
              <div class="bar" class:on style={`width:${width}%`}></div>
            {/if}
          </div>

          <div class="meta">
            {#if r.indexed === false}
              <span>no transcript indexed for this session yet</span>
            {:else}
              <span title={exactTokens(totalTokens(r.usage))}>{compactTokens(totalTokens(r.usage))} tokens</span>
              {#if r.usage?.messages}<span>{r.usage.messages.toLocaleString('en-US')} turns</span>{/if}
              {#if r.unpriced?.length}<span class="warn">{r.unpriced.length} unpriced model{r.unpriced.length === 1 ? '' : 's'}</span>{/if}
            {/if}
          </div>
        </div>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .none { margin: 0; padding: 14px 0; font-size: 12.5px; color: var(--faint); }
  .rank { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }

  .row {
    display: flex; flex-direction: column; gap: 5px;
    padding: 9px 11px; border-radius: 9px; cursor: pointer;
    border: 1px solid transparent;
  }
  .row:hover { background: var(--elevated); }
  .row.on { background: var(--elevated); border-color: var(--border); }
  .row.unindexed { opacity: .62; }

  .head { display: flex; align-items: baseline; gap: 9px; }
  .grow { flex: 1; }
  .name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sub { font-family: var(--mono); font-size: 10.5px; color: var(--faint); }
  /* Values wear text tokens, never the mark's color. */
  .val { font-family: var(--mono); font-size: 12.5px; font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; }
  .val.muted { font-weight: 500; color: var(--faint); }

  /* Bar: thin, grows from a single baseline, 4px rounded at the data end and square at
     the baseline. No track fill — an empty track would read as a second value. */
  .track { height: 8px; display: flex; align-items: stretch; }
  .bar { background: var(--viz-deemph); border-radius: 1px 4px 4px 1px; min-width: 3px; }
  .bar.on { background: var(--brand); }

  .meta {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    font-family: var(--mono); font-size: 10.5px; color: var(--faint);
  }
  .meta .warn { color: var(--waiting); }
</style>
