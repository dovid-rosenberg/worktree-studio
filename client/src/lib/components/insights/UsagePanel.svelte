<script lang="ts">
  // Fleet telemetry: what every Studio session has cost, rolled up by feature.
  //
  // One request answers the whole view (/transcripts/usage returns per-session, per-
  // feature and grand totals in one shot), so this holds one payload and never fans out.
  //
  // Layout follows the data's job rather than habit:
  //   · the total is ONE hero figure, not a bar chart of one bar;
  //   · the KPI row is stat tiles, because four headline numbers are not a chart;
  //   · "where did it go" is an emphasis ranking, one flat gray with the selection in
  //     the brand hue — the rows are nominal, so shading them by size would say nothing;
  //   · volume-vs-cost lives in the per-session detail, where TokenMix can show both
  //     scales side by side instead of letting cache reads impersonate spend.
  import './viz.css';
  import { fleetUsage, transcriptStatus, reindex } from './api.js';
  import CostRanking from './CostRanking.svelte';
  import SessionUsage from './SessionUsage.svelte';
  import EstimateNote from './EstimateNote.svelte';
  import IndexStatus from './IndexStatus.svelte';
  import { usd, compactTokens, exactTokens, totalTokens, pct, share, writeMultiplier } from './format.js';

  /** @type {{ sessionId?: string|null, onselect?: (id: string) => void }} */
  let { sessionId = null, onselect = () => {} } = $props();

  import type { FleetUsage } from './types';
  import { errMessage } from '$lib/errmsg.js';
    let data: FleetUsage|null = $state(null);
    let status: import('./types.js').TranscriptStatus|null = $state(null);
  let loading = $state(true);
    let error: string|null = $state(null);
  let busy = $state(false);

  let group = $state<'feature'|'session'>('feature');
  // Deliberately the INITIAL value only: the prop seeds which row opens, after which
  // the selection belongs to the user. A derived would yank them back to the shell's
  // session every time it changed.
  // svelte-ignore state_referenced_locally
    let picked: string|null = $state(sessionId);

  // Plain `let`, deliberately NOT $state: `load()` runs inside an $effect, so reading a
  // reactive value in its synchronous prologue would make the effect depend on it —
  // and since load() also writes `data`, that dependency is an infinite refetch loop.
  let everLoaded = false;

  async function load(refresh = false) {
    busy = refresh;
    if (!everLoaded) loading = true;
    error = null;
    try {
      const [u, s] = await Promise.all([fleetUsage({ refresh }), transcriptStatus()]);
      data = u;
      status = s;
      // Land on the biggest spender so the view has a subject on first paint, and so
      // the emphasis in the ranking always means the same thing as the selection.
      if (!picked) picked = u.sessions.find((x) => (x.costUsd || 0) > 0)?.session?.id ?? u.sessions[0]?.session?.id ?? null;
    } catch (e) {
      error = errMessage(e);
    } finally {
      everLoaded = true;
      loading = false;
      busy = false;
    }
  }

  // Mount only. Nothing reactive is read in load()'s synchronous prologue, so this
  // effect has no dependencies and cannot re-run.
  $effect(() => { load(); });

  // `$derived.by` rather than `$derived` throughout, and not for style: `data` is
  // declared as `$state(null)`, so TypeScript's control-flow analysis narrows it to
  // exactly `null` for every read in this same scope and the whole payload types as
  // `never`. A closure is a function boundary, which resets the narrowing to the
  // declared type. Same reason the markup below can read `data?.pricing` directly.
  const sessions = $derived.by(() => data?.sessions ?? []);
  const features = $derived.by(() => data?.features ?? []);
  const totals = $derived.by(() => data?.totals ?? null);
  const selected = $derived.by(() => sessions.find((s) => s.session?.id === picked) ?? null);

  const indexedCount = $derived.by(() => sessions.filter((s) => s.indexed !== false).length);

  const featureRows = $derived.by(() =>
    features.map((f) => ({
      key: f.feature,
      label: f.feature,
      sub: `${f.sessions} session${f.sessions === 1 ? '' : 's'}`,
      costUsd: f.costUsd,
      usage: f,
      // A feature is "not indexed" only when nothing under it is.
      indexed: sessions.some((s) => (s.session?.feature || s.session?.id) === f.feature && s.indexed !== false),
      unpriced: f.unpricedModels,
    })),
  );

  const sessionRows = $derived.by(() =>
    sessions.map((s) => ({
      key: s.session?.id ?? '',
      label: s.session?.title ?? s.session?.id ?? '—',
      sub: [s.session?.repo, s.session?.branch].filter(Boolean).join(' · '),
      costUsd: s.costUsd,
      usage: s,
      indexed: s.indexed,
      unpriced: s.unpricedModels,
    })),
  );

  /** @param {string} key */
  function selectRow(key: string) {
    if (group === 'session') {
      picked = key;
    } else {
      // A feature row selects the costliest session under it — the detail pane only
      // knows how to render a session, and that is the one worth looking at.
      const under = sessions.filter((s) => (s.session?.feature || s.session?.id) === key);
      picked = under[0]?.session?.id ?? picked;
    }
    if (picked) onselect(picked);
  }

  const selectedKey = $derived(
    group === 'session'
      ? picked
      : (selected?.session?.feature || selected?.session?.id || null),
  );
</script>

<section class="usage" aria-label="Token and cost telemetry">
  {#if loading}
    <p class="msg">Loading telemetry…</p>
  {:else if error}
    <p class="msg bad">{error} <button class="btn sm" onclick={() => load()}>Retry</button></p>
  {:else if totals}
    <!-- Exactly one hero figure per view. -->
    <header class="hero">
      <div class="heroline">
        <div>
          <span class="lbl">Estimated spend, all sessions</span>
          <b class="herofig">{usd(totals.costUsd) ?? '—'}</b>
        </div>
        <span class="grow"></span>
        <button class="btn sm" disabled={busy} onclick={() => load(true)}>
          {busy ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <EstimateNote pricing={data?.pricing} unpricedModels={totals.unpricedModels} />
    </header>

    <!-- Four headline numbers are a KPI row, not a grouped bar chart. -->
    <div class="kpis">
      <div class="kpi">
        <span class="lbl">Tokens</span>
        <b title={exactTokens(totalTokens(totals))}>{compactTokens(totalTokens(totals))}</b>
        <small>{pct(share(totals.cacheRead, totalTokens(totals)))} of it cache reads</small>
      </div>
      <div class="kpi">
        <span class="lbl">Output</span>
        <b title={exactTokens(totals.output)}>{compactTokens(totals.output)}</b>
        <small>the tokens Claude actually wrote</small>
      </div>
      <div class="kpi">
        <span class="lbl">Cache writes</span>
        <b title={exactTokens(totals.cacheWrite)}>{compactTokens(totals.cacheWrite)}</b>
        <!-- The blended multiplier, not a guess from whichever TTL is nonzero: a fleet
             that mixes 5m and 1h writes sits between 1.25x and 2x. -->
        <small>billing at {writeMultiplier(totals).toFixed(2).replace(/\.?0+$/, '')}× the input rate</small>
      </div>
      <div class="kpi">
        <span class="lbl">Sessions</span>
        <b>{indexedCount}<em>/{sessions.length}</em></b>
        <small>indexed</small>
      </div>
    </div>

    {#if status && (!status.ready || !status.messages || status.fts5 === false)}
      <IndexStatus
        {status}
        {busy}
        onreindex={async (o: { session?: string | null; full?: boolean }) => {
          busy = true;
          try { await reindex(o); } finally { await load(); }
        }}
      />
    {/if}

    <div class="cols">
      <div class="card rankcard">
        <div class="cardhd">
          <h3>Where it went</h3>
          <!-- One filter row for the thing it scopes; it re-groups, it never recolors. -->
          <div class="viewseg" role="group" aria-label="Group cost by">
            <button class:on={group === 'feature'} onclick={() => { group = 'feature'; }}>Feature</button>
            <button class:on={group === 'session'} onclick={() => { group = 'session'; }}>Session</button>
          </div>
        </div>
        <CostRanking
          rows={group === 'feature' ? featureRows : sessionRows}
          selected={selectedKey}
          onselect={selectRow}
          emptyLabel="No sessions are indexed yet."
        />
        <!-- No legend swatches here on purpose. This is a single series, so a legend
             would only restate the title — and the token mix beside it is already
             spending three categorical hues. Two colour keys side by side invite the
             reader to map one chart's orange onto the other's. The highlighted row
             carries the selection, which the row background states as well. -->
        <p class="cardfoot">Bar length is estimated cost, nothing else. The highlighted row is the one detailed on the right.</p>
      </div>

      <div class="card detailcard">
        <div class="cardhd">
          <h3>{selected?.session?.title ?? 'Session'}</h3>
          {#if selected?.session?.branch}<span class="sub">{selected.session.branch}</span>{/if}
        </div>
        {#if selected}
          {#key selected.session?.id}
            <!-- The hero above already carries the estimate disclosure; repeating it
                 here would train the eye to skip it. Unpriced models still surface. -->
            <SessionUsage usage={selected} pricing={data?.pricing} estimateLine={false} />
          {/key}
        {:else}
          <p class="msg">Pick a row to see its token mix and per-model cost.</p>
        {/if}
      </div>
    </div>

    <footer class="foot">
      <IndexStatus {status} compact />
    </footer>
  {/if}
</section>

<style>
  .usage { display: flex; flex-direction: column; gap: 18px; padding: 18px; min-height: 0; }
  .msg { margin: 0; font-size: 13px; color: var(--muted); display: flex; align-items: center; gap: 10px; }
  .msg.bad { color: var(--waiting); }
  .grow { flex: 1; }

  .lbl {
    display: block; font-family: var(--mono); font-size: 9.5px; letter-spacing: .08em;
    text-transform: uppercase; color: var(--faint); margin-bottom: 3px;
  }

  .hero { display: flex; flex-direction: column; gap: 11px; }
  .heroline { display: flex; align-items: flex-end; gap: 14px; }
  /* The one hero number, in the system sans, proportional figures. */
  .herofig { font-size: 52px; line-height: 1; font-weight: 700; letter-spacing: -.025em; color: var(--ink); }

  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
  .kpi {
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 11px 13px; display: flex; flex-direction: column; gap: 1px;
  }
  .kpi b { font-size: 22px; font-weight: 650; letter-spacing: -.015em; }
  .kpi b em { font-style: normal; font-size: 14px; font-weight: 500; color: var(--faint); }
  .kpi small { font-family: var(--mono); font-size: 10px; color: var(--faint); line-height: 1.4; }

  .cols { display: grid; grid-template-columns: minmax(300px, 400px) 1fr; gap: 16px; align-items: start; }
  @media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }

  .card {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 12px; padding: 14px; min-width: 0;
  }
  .cardhd { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
  .cardhd h3 { margin: 0; font-size: 14px; font-weight: 650; }
  .cardhd .sub { font-family: var(--mono); font-size: 11px; color: var(--faint); }
  .cardhd .viewseg { margin-left: auto; }

  .viewseg { display: flex; background: var(--elevated); border: 1px solid var(--border); border-radius: 9px; padding: 2px; gap: 2px; }
  .viewseg button {
    font-family: var(--sans); font-size: 11.5px; font-weight: 600; border: 0;
    background: transparent; color: var(--muted); padding: 4px 11px; border-radius: 7px; cursor: pointer;
  }
  .viewseg button.on { background: var(--brand); color: var(--brand-ink); }

  .cardfoot {
    margin: 12px 0 0; padding-top: 10px; border-top: 1px solid var(--border);
    font-family: var(--mono); font-size: 10px; color: var(--faint);
    line-height: 1.5;
  }

  .foot { border-top: 1px solid var(--border); padding-top: 11px; }
</style>
