<script>
  // The cost disclosure.
  //
  // Every cost figure in Studio is derived: Claude Code transcripts record tokens and
  // no billing, so the dollars come from a hand-maintained price table that goes stale
  // (server/pricing.js says so in its own header). The server flags this on every
  // payload with costIsEstimate: true.
  //
  // Placement is the whole design decision. Buried in a tooltip it may as well not
  // exist — a reader who never hovers walks away believing a billed number. Shouted in
  // a red banner it becomes chrome to scroll past, and it isn't an error. So: a plain
  // line under the figure it qualifies, in muted ink, with the price-table date visible
  // because staleness is the actual failure mode; the mechanics fold away behind a
  // <details> for anyone who wants them.
  /**
   * @type {{
   *   pricing?: { verifiedAt: string, note: string }|null,
   *   unpricedModels?: string[],
   *   compact?: boolean,
   *   line?: boolean,
   * }}
   */
  let {
    pricing = null,
    unpricedModels = [],
    compact = false,
    /**
     * Drop the estimate sentence but keep the unpriced-model callout. For a detail pane
     * nested under a view that already carries the disclosure — repeating it two lines
     * down turns it into wallpaper, which is the failure mode this component exists to
     * avoid. The unpriced list is never suppressed: it is per-session data, not a caveat.
     */
    line = true,
  } = $props();

  const verified = $derived(pricing?.verifiedAt || null);
  const stale = $derived.by(() => {
    if (!verified) return false;
    const t = Date.parse(verified);
    if (!Number.isFinite(t)) return false;
    // Anthropic ships models faster than this table gets edited; a quarter is the point
    // at which "verified" stops being a reassurance.
    return Date.now() - t > 90 * 86400e3;
  });
</script>

<div class="est" class:compact>
  {#if line}
    <p class="line">
      <span class="tag">estimate</span>
      Transcripts record tokens, not billing — every figure here is priced from a
      maintained table{#if verified}, last verified <span class:stale>{verified}</span>{/if}.
    </p>
  {/if}

  {#if unpricedModels.length}
    <p class="unpriced">
      <span class="warn">!</span>
      {unpricedModels.length === 1 ? 'One model has' : `${unpricedModels.length} models have`}
      no entry in that table — {#each unpricedModels as m, i (m)}<code>{m}</code>{#if i < unpricedModels.length - 1}, {/if}{/each}.
      Their tokens are counted below; their cost is <b>not</b> in any total on this page.
    </p>
  {/if}

  {#if !compact}
    <details>
      <summary>How the numbers are derived</summary>
      <ul>
        <li>Input and output tokens are billed at the model's published per-million rates.</li>
        <li>Cache <b>writes</b> bill at 1.25&times; the input rate for a 5-minute TTL and 2&times; for a 1-hour one; cache <b>reads</b> at 0.1&times;.</li>
        <li>Usage is de-duplicated on the API message id. Claude Code writes one transcript line per content block and repeats the same usage on each, so counting lines overstates a tool-heavy session by roughly 3&times;.</li>
        <li>First-party API rates only. Bedrock and Vertex are partner-priced and are not modelled.</li>
        <li>A model missing from the table returns no cost rather than a guessed one.</li>
      </ul>
    </details>
  {/if}
</div>

<style>
  .est { display: flex; flex-direction: column; gap: 7px; }
  .line { margin: 0; font-size: 12px; line-height: 1.55; color: var(--muted); }
  .compact .line { font-size: 11.5px; }

  .tag {
    font-family: var(--mono); font-size: 9.5px; font-weight: 700;
    text-transform: uppercase; letter-spacing: .07em;
    color: var(--waiting); background: var(--waiting-bg);
    border-radius: 4px; padding: 2px 7px; margin-right: 7px;
    vertical-align: 1px;
  }
  .line .stale { color: var(--waiting); font-weight: 600; }

  .unpriced {
    margin: 0; font-size: 12px; line-height: 1.55; color: var(--ink);
    background: var(--waiting-bg); border-radius: 8px; padding: 8px 11px;
    box-shadow: inset 3px 0 0 var(--waiting);
  }
  .unpriced .warn { color: var(--waiting); font-weight: 700; margin-right: 6px; }
  .unpriced code { font-family: var(--mono); font-size: 11.5px; }

  details { font-size: 12px; color: var(--muted); }
  summary { cursor: pointer; font-family: var(--mono); font-size: 10.5px; color: var(--faint); }
  summary:hover { color: var(--brand); }
  details ul { margin: 8px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 5px; }
  details li { line-height: 1.55; }
</style>
