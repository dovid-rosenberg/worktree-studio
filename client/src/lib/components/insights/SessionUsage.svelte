<script lang="ts">
// One session's telemetry: cost, the token mix, and the per-model breakdown.
//
// Usable two ways — handed a payload by the fleet view (no fetch), or given a session
// id and left to fetch its own. The second is what a session-scoped mount in the shell
// will want; the first is what keeps the fleet view from issuing N requests for data
// /transcripts/usage already returned.
import { sessionUsage } from './api.js';
import TokenMix from './TokenMix.svelte';
import EstimateNote from './EstimateNote.svelte';
import {
  usd,
  compactTokens,
  exactTokens,
  totalTokens,
  shortModel,
  span,
  stamp,
  pct,
  share,
} from './format.js';
import type { ModelUsage } from './types';
import { errMessage, isAbort } from '$lib/errmsg.js';

/**
 * @type {{
 *   usage?: import('./types.js').Usage|null,
 *   sessionId?: string|null,
 *   pricing?: import('./types.js').PricingBlock|null,
 *   title?: string|null,
 *   estimateLine?: boolean,
 * }}
 */
let { usage = null, sessionId = null, pricing = null, title = null, estimateLine = true } = $props();

let fetched: import('./types.js').Usage | null = $state(null);
let loading = $state(false);
let error: string | null = $state(null);

$effect(() => {
  if (usage || !sessionId) return;
  const id = sessionId;
  const ctrl = new AbortController();
  loading = true;
  error = null;
  sessionUsage(id, ctrl.signal)
    .then((u) => {
      fetched = u;
    })
    .catch((e) => {
      if (!isAbort(e)) error = errMessage(e);
    })
    .finally(() => {
      loading = false;
    });
  return () => ctrl.abort();
});

const u = $derived(usage || fetched);
const models = $derived(u?.byModel ?? []);
const unpriced = $derived(u?.unpricedModels ?? []);
const heading = $derived(title || u?.session?.title || sessionId || 'Session');
const turns = $derived(u?.messages ?? u?.assistantMessages ?? 0);

// `priced:false` covers two different situations and they must not render alike.
// A model the price table simply lacks is a GAP — it is in unpricedModels and its
// tokens are missing from every total. `<synthetic>` is different: Claude Code emits
// those lines locally for interrupts and API errors, they carry an all-zero usage
// block, and the server deliberately keeps them out of unpricedModels. Calling that
// "unpriced" would invent a hole in the numbers that doesn't exist.
/** @param {import('./types.js').ModelUsage} m */
const costCell = (m: ModelUsage) => {
  if (m.priced) return { text: usd(m.costUsd) ?? '—', kind: 'ok' };
  if (unpriced.includes(m.model ?? 'unknown')) return { text: 'unpriced', kind: 'gap' };
  return { text: 'not billed', kind: 'none' };
};

const totalCost = $derived(u?.costUsd ?? null);
</script>

<section class="su" aria-label={`Token and cost telemetry for ${heading}`}>
  {#if loading && !u}
    <p class="msg">Loading telemetry…</p>
  {:else if error}
    <p class="msg bad">{error}</p>
  {:else if !u}
    <p class="msg">No telemetry.</p>
  {:else}
    <header class="hd">
      <div class="figs">
        <div class="fig">
          <span class="lbl">Estimated cost</span>
          <b class="val big">{usd(totalCost) ?? '—'}</b>
        </div>
        <div class="fig">
          <span class="lbl">Tokens</span>
          <b class="val" title={exactTokens(totalTokens(u))}>{compactTokens(totalTokens(u))}</b>
        </div>
        <div class="fig">
          <span class="lbl">Turns</span>
          <b class="val">{turns.toLocaleString('en-US')}</b>
        </div>
        {#if u.firstAt && u.lastAt}
          <div class="fig">
            <span class="lbl">Active over</span>
            <b class="val" title={`${stamp(u.firstAt)} → ${stamp(u.lastAt)}`}>{span(u.firstAt, u.lastAt) || '—'}</b>
          </div>
        {/if}
      </div>
      <EstimateNote {pricing} unpricedModels={unpriced} compact line={estimateLine} />
    </header>

    {#if u.source === 'none'}
      <p class="msg">
        No transcript found for this session{#if u.reason} — {u.reason}{/if}.
      </p>
    {:else}
      <div class="mix"><TokenMix usage={u} /></div>

      <div class="models">
        <h4>By model</h4>
        <table>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col" class="n">Turns</th>
              <th scope="col" class="n">Input</th>
              <th scope="col" class="n">Output</th>
              <th scope="col" class="n">Cache write</th>
              <th scope="col" class="n">Cache read</th>
              <th scope="col" class="n">Cost</th>
            </tr>
          </thead>
          <tbody>
            {#each models as m, i (`${m.model}-${m.speed}-${i}`)}
              {@const cell = costCell(m)}
              <tr>
                <th scope="row">
                  {shortModel(m.model)}
                  {#if m.speed && m.speed !== 'standard'}<em class="speed">{m.speed}</em>{/if}
                </th>
                <td class="n">{(m.messages || 0).toLocaleString('en-US')}</td>
                <td class="n" title={exactTokens(m.input)}>{compactTokens(m.input)}</td>
                <td class="n" title={exactTokens(m.output)}>{compactTokens(m.output)}</td>
                <td class="n" title={`5m ${exactTokens(m.cacheWrite5m)} · 1h ${exactTokens(m.cacheWrite1h)}`}>{compactTokens(m.cacheWrite)}</td>
                <td class="n" title={exactTokens(m.cacheRead)}>{compactTokens(m.cacheRead)}</td>
                <td class="n cost {cell.kind}">
                  {cell.text}
                  {#if cell.kind === 'ok' && totalCost}<span class="pctof">{pct(share(m.costUsd || 0, totalCost))}</span>{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        {#if (u.webSearch || 0) + (u.webFetch || 0) > 0}
          <p class="tools">
            Server tools: {u.webSearch || 0} web search{(u.webSearch || 0) === 1 ? '' : 'es'},
            {u.webFetch || 0} web fetch{(u.webFetch || 0) === 1 ? '' : 'es'} — billed per request, not per token, and not in the figure above.
          </p>
        {/if}
      </div>
    {/if}
  {/if}
</section>

<style>
  .su { display: flex; flex-direction: column; gap: 18px; }
  .msg { margin: 0; font-size: 12.5px; color: var(--muted); }
  .msg.bad { color: var(--waiting); }

  .hd { display: flex; flex-direction: column; gap: 11px; }
  .figs { display: flex; gap: 28px; flex-wrap: wrap; }
  .fig { display: flex; flex-direction: column; gap: 2px; }
  .lbl {
    font-family: var(--mono); font-size: 9.5px; letter-spacing: .08em;
    text-transform: uppercase; color: var(--faint);
  }
  /* Proportional figures on standalone values; tabular is for columns. */
  .val { font-size: 17px; font-weight: 650; color: var(--ink); }
  .val.big { font-size: 26px; letter-spacing: -.015em; }

  .models h4 {
    margin: 0 0 8px; font-family: var(--mono); font-size: 9.5px; letter-spacing: .08em;
    text-transform: uppercase; color: var(--faint); font-weight: 600;
  }
  .models table { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 11px; }
  .models th, .models td { padding: 6px 8px; text-align: left; white-space: nowrap; }
  .models thead th {
    font-size: 9.5px; letter-spacing: .07em; text-transform: uppercase;
    color: var(--faint); font-weight: 600; border-bottom: 1px solid var(--border);
  }
  .models tbody th { font-weight: 500; color: var(--ink); }
  .models tbody td { color: var(--muted); }
  .models tbody tr + tr th, .models tbody tr + tr td { border-top: 1px solid var(--border); }
  .models .n { text-align: right; font-variant-numeric: tabular-nums; }
  .models .cost { color: var(--ink); font-weight: 600; }
  .models .cost.gap { color: var(--waiting); }
  .models .cost.none { color: var(--faint); font-weight: 500; }
  .models .pctof { color: var(--faint); font-weight: 500; margin-left: 7px; }
  .speed { font-style: normal; color: var(--working); margin-left: 5px; font-size: 10px; }

  .tools { margin: 9px 0 0; font-size: 11.5px; color: var(--muted); line-height: 1.5; }
</style>
