<script lang="ts">
// Volume vs. billed weight, for one usage record.
//
// ── why this exists ──────────────────────────────────────────────────────────
// The naive chart here is a bar per token class. On real data that chart is one
// enormous cache-read bar and three invisible stubs, and every reader takes away
// "cache reads are where the money goes". They are not. Cache reads bill at a TENTH
// of the input rate while 1-hour cache writes bill at DOUBLE it, so a class's share
// of the tokens and its share of the bill differ by up to twentyfold.
//
// So the chart shows both, on the same 0-100% axis, as two stacked bars of the same
// three classes: the boundaries move between the bars, and that movement IS the
// point. Both quantities are shares of their own total, so one axis is honest — this
// is not a dual scale.
//
// What "billed weight" is: each class restated in input-rate-equivalent tokens
// (x1, x1.25, x2, x0.1). See format.js — it is exactly proportional to the dollars
// each class contributed, for every model, without the client knowing any rate.
//
// Output is deliberately absent from both bars. It bills on a separate output rate
// whose ratio to the input rate is a per-model price, not a structural multiplier, so
// there is no honest way to put it on this scale. It is reported underneath instead.
import './viz.css';
import {
  compactTokens,
  exactTokens,
  pct,
  share,
  usd,
  volumeByClass,
  weightByClass,
  writeMultiplier,
} from './format.js';
import { billingMultipliers } from './pricing.svelte.js';

let { usage = null, dense = false }: { usage: import('./types.js').Usage | null; dense?: boolean } = $props();

const vol = $derived(volumeByClass(usage));
const wt = $derived(weightByClass(usage));
const volTotal = $derived(vol.input + vol.cacheWrite + vol.cacheRead);
const wtTotal = $derived(wt.input + wt.cacheWrite + wt.cacheRead);
const writeMult = $derived(writeMultiplier(usage));
const output = $derived(usage?.output || 0);

// Written out rather than mapped over a key list: the slot each class gets is a fixed
// assignment by ENTITY (blue=input, orange=cache write, aqua=cache read) and must
// never be derived from position, rank or a loop index.
const rows = $derived([
  {
    key: 'input',
    label: 'Input',
    slot: 's1',
    mult: billingMultipliers.input,
    tokens: vol.input,
    weight: wt.input,
    volShare: share(vol.input, volTotal),
    wtShare: share(wt.input, wtTotal),
  },
  {
    key: 'cacheWrite',
    label: 'Cache write',
    slot: 's2',
    mult: writeMult,
    tokens: vol.cacheWrite,
    weight: wt.cacheWrite,
    volShare: share(vol.cacheWrite, volTotal),
    wtShare: share(wt.cacheWrite, wtTotal),
  },
  {
    key: 'cacheRead',
    label: 'Cache read',
    slot: 's3',
    mult: billingMultipliers.cacheRead,
    tokens: vol.cacheRead,
    weight: wt.cacheRead,
    volShare: share(vol.cacheRead, volTotal),
    wtShare: share(wt.cacheRead, wtTotal),
  },
]);

// The largest gap between a class's two shares — the sentence the chart is making,
// stated in words so it doesn't depend on the reader decoding the bars.
const headline = $derived.by(() => {
  if (!volTotal || !wtTotal) return null;
  let best = null;
  for (const r of rows) {
    const delta = r.wtShare - r.volShare;
    if (!best || Math.abs(delta) > Math.abs(best.delta)) best = { ...r, delta };
  }
  return best && Math.abs(best.delta) >= 5 ? best : null;
});

// A nonzero class must not render as nothing — 0.02% is 0.2px on a 1000px bar. The
// floor is visual only; every exact figure is in the table below, which is also the
// relief the light-mode palette WARN requires.
const MIN_SEG = 3;
/** @param {number} v @param {number} total */
const segStyle = (v: number, total: number) =>
  v > 0 ? `flex: 1 1 ${share(v, total)}%; min-width: ${MIN_SEG}px;` : 'display:none;';
</script>

{#if !volTotal}
  <p class="none">No input tokens recorded for this session yet.</p>
{:else}
  <figure class="mix" class:dense>
    <figcaption class="cap">
      <h4>Token mix</h4>
      {#if headline}
        <p>
          <b>{headline.label}</b> is {pct(headline.volShare)} of the tokens but
          {pct(headline.wtShare)} of the bill.
        </p>
      {/if}
    </figcaption>

    <div class="bars">
      <div class="barrow">
        <span class="blabel">share of tokens</span>
        <div class="viz-stack">
          {#each rows as r (r.key)}
            <div
              class="viz-seg {r.slot}"
              style={segStyle(r.tokens, volTotal)}
              title={`${r.label}: ${exactTokens(r.tokens)} tokens (${pct(r.volShare)} of input-family tokens)`}
            ></div>
          {/each}
        </div>
      </div>

      <div class="barrow">
        <span class="blabel">share of billed weight</span>
        <div class="viz-stack">
          {#each rows as r (r.key)}
            <div
              class="viz-seg {r.slot}"
              style={segStyle(r.weight, wtTotal)}
              title={`${r.label}: ${pct(r.wtShare)} of the input-family bill (${r.mult.toFixed(2)}x the input rate)`}
            ></div>
          {/each}
        </div>
      </div>
    </div>

    <!-- Two series or more: a legend is always present, and identity rides the swatch,
         never the text color. -->
    <div class="viz-legend">
      {#each rows as r (r.key)}
        <span class="viz-key"><i class="viz-swatch {r.slot}"></i>{r.label}<em>&times;{r.mult.toFixed(2).replace(/\.?0+$/, '')}</em></span>
      {/each}
    </div>

    <table class="mixtable">
      <caption class="vh">Exact token counts and billed weight per class</caption>
      <thead>
        <tr>
          <th scope="col">Class</th>
          <th scope="col" class="n">Tokens</th>
          <th scope="col" class="n">Share</th>
          <th scope="col" class="n">Billed weight</th>
          <th scope="col" class="n">Share</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as r (r.key)}
          <tr>
            <th scope="row"><i class="viz-swatch {r.slot}"></i>{r.label}</th>
            <td class="n" title={exactTokens(r.tokens)}>{compactTokens(r.tokens)}</td>
            <td class="n dim">{pct(r.volShare)}</td>
            <td class="n" title={exactTokens(r.weight)}>{compactTokens(r.weight)}</td>
            <td class="n">{pct(r.wtShare)}</td>
          </tr>
        {/each}
      </tbody>
    </table>

    <p class="foot">
      <b>Billed weight</b> restates each class in input-rate-equivalent tokens, which is
      exactly proportional to the dollars it contributed — no model's actual rate is needed.
      {#if output}
        <br />
        <b>Output</b> — <span title={exactTokens(output)}>{compactTokens(output)} tokens</span> — is
        not on this scale: it bills on a separate output rate, so its share is only
        comparable per model. See the model breakdown{#if usage?.costUsd != null}; the whole
        session estimates to {usd(usage.costUsd)}{/if}.
      {/if}
    </p>
  </figure>
{/if}

<style>
  .mix { margin: 0; display: flex; flex-direction: column; gap: 12px; }
  .none { margin: 0; font-size: 12.5px; color: var(--faint); }

  .cap { display: flex; flex-direction: column; gap: 3px; }
  .cap h4 {
    margin: 0; font-family: var(--mono); font-size: 9.5px; letter-spacing: .08em;
    text-transform: uppercase; color: var(--faint); font-weight: 600;
  }
  .cap p { margin: 0; font-size: 13px; line-height: 1.5; color: var(--ink); }

  .bars { display: flex; flex-direction: column; gap: 9px; }
  .barrow { display: grid; grid-template-columns: 150px 1fr; align-items: center; gap: 12px; }
  .blabel { font-family: var(--mono); font-size: 10.5px; color: var(--muted); text-align: right; }
  .dense .barrow { grid-template-columns: 120px 1fr; }

  /* The gap between segments is cut out of the card surface, so it reads as air. */
  .viz-stack { background: var(--viz-surface); }
  .viz-seg { transition: filter .12s; }
  .viz-seg:hover { filter: brightness(1.15); }
  @media (prefers-reduced-motion: reduce) { .viz-seg { transition: none; } }

  .viz-key em { font-style: normal; color: var(--faint); margin-left: 2px; }

  .mixtable { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 11px; }
  .mixtable th, .mixtable td { padding: 5px 8px; text-align: left; }
  .mixtable thead th {
    font-size: 9.5px; letter-spacing: .07em; text-transform: uppercase;
    color: var(--faint); font-weight: 600; border-bottom: 1px solid var(--border);
  }
  .mixtable tbody th { font-weight: 500; color: var(--ink); display: flex; align-items: center; gap: 7px; }
  .mixtable td { color: var(--muted); }
  .mixtable .n { text-align: right; font-variant-numeric: tabular-nums; }
  .mixtable tbody td:last-child { color: var(--ink); }
  .mixtable .dim { color: var(--faint); }
  .mixtable tbody tr + tr th, .mixtable tbody tr + tr td { border-top: 1px solid var(--border); }

  .foot { margin: 0; font-size: 11.5px; line-height: 1.55; color: var(--muted); }

  .vh {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }
</style>
