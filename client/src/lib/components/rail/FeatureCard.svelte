<script lang="ts">
  import type { Feature } from '../../../../../server/types';
  /*
   * One FEATURE in the rail — the unit the rail is keyed on.
   *
   * The card is a pure readout: name, state, member chips. It carries no buttons at all,
   * and its height therefore never changes.
   *
   * TWO SIGNALS, NOT SIX. It used to carry a state dot, an `agent · <state>` pill with a
   * SECOND dot encoding the same value eight pixels away, a `⇅ servers · stopped` pill, a
   * dot per member repo, a merged badge, a slot badge and a green left edge — about six
   * glyphs a card, so seven cards meant scanning forty to find the one waiting agent.
   *
   * Now: the dot is agent state, the green left edge is "dev servers up", and everything
   * else appears only when it is NOT the default. `servers · stopped` and `agent · idle`
   * were the two most common labels on screen and both said nothing was happening —
   * absence says that for free, and it lets `waiting` stand out instead of queue up. That is the point. The earlier
   * version revealed quick actions on hover, which grew the card and reflowed every row
   * beneath it — so moving the pointer down the rail made the list jump under the cursor
   * and the row you were aiming at moved before you clicked. Every action that used to
   * live here (including the ⋯ menu's) is now in the bottom ActionBar, which is always
   * present and cannot shift anything.
   */
  import { ui, liveMembers } from '$lib/stores/ui.svelte.js';

  let { feature }: { feature: Feature } = $props();

  const ms = $derived(liveMembers(feature));
  const anyRunning = $derived(ms.some((m) => m.running));
  const sess = $derived(feature.session); // one session per feature
  const anyMerged = $derived(ms.some((m) => m.merged));

  const selected = $derived(
    sess ? ui.selectedId === sess.id : ui.selectedFeatureName === feature.name,
  );

  /**
   * An agent state worth a label. `idle` is the resting state and `stopped` is covered
   * by the dimmed dot, so neither earns a pill — only working/waiting do, which is what
   * makes `waiting` findable.
   */
  const notable = $derived(!!sess && sess.state !== 'idle' && sess.state !== 'stopped');

</script>

<div class="fcard" class:sel={selected} class:running={anyRunning} role="listitem">
  <button
    class="hit"
    onclick={() => ui.selectFeature(feature)}
    aria-pressed={selected}
    aria-label="Select feature {feature.name}"
  >
    <div class="l1">
      <span class="dot {sess ? sess.state : (anyRunning ? 'done' : 'idle')}"></span>
      <span class="fname">{feature.name}</span>
      {#if !feature.auto}<span class="src" title="Grouped by config.groups, not by name">manual</span>{/if}
      {#if anyMerged}<span class="badge merged" title="Branch merged into its base">✓</span>{/if}
      {#if feature.slot != null}
        <span class="badge slot" title="Concurrency slot — its ports are offset by slot·100">{feature.slot}</span>
      {/if}
    </div>

    <!-- Only what is not the default. An idle agent and stopped servers say nothing;
         their absence says it without spending a row of attention on it. -->
    {#if notable || ms.length > 1}
      <div class="l2">
        {#if sess && notable}
          <span class="pill agent {sess.state}" title="Agent — the Claude session">{sess.state}</span>
        {/if}
        {#if !sess}<span class="noagent">no agent</span>{/if}
        {#if ms.length > 1}<span class="nrepos">{ms.length} repos</span>{/if}
      </div>
    {/if}

    <div class="l3">
      {#each ms as m (m.path)}
        <span class="mchip">
          <span class="r">{m.repo}</span>
          <span class="br">{m.branch || m.wtname}</span>
          {#if (m.ports || []).length}
            <span class="p">{m.ports.map((p: number) => ':' + p).join(' ')}</span>
          {/if}
        </span>
      {/each}
    </div>

    {#if sess && sess.activity}<div class="act">{sess.activity}</div>{/if}
  </button>
</div>

<style>
  .fcard { border:1px solid var(--border); border-radius:10px; background:var(--panel); margin:0 8px 6px;
           transition:border-color .12s, background .12s; }
  @media (prefers-reduced-motion:reduce){ .fcard { transition:none; } }
  .fcard:hover { border-color:var(--border-strong); }
  .fcard.sel { border-color:var(--brand); background:var(--elevated); }
  .fcard.running { box-shadow:inset 3px 0 0 var(--done); }

  /* min-width:0 at every level: without it a long branch name or a four-port list makes
     the flex children refuse to shrink and the whole rail grows a horizontal scrollbar. */
  .hit { display:block; width:100%; min-width:0; text-align:left; background:none; border:0;
         padding:10px 11px 8px; cursor:pointer; color:inherit; font-family:inherit; overflow:hidden; }

  .l1 { display:flex; align-items:center; gap:7px; min-width:0; }
  .fname { font-weight:600; font-size:13px; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .l2 { display:flex; align-items:center; gap:6px; margin-top:6px; flex-wrap:wrap; min-width:0; }
  .l3 { display:flex; flex-direction:column; gap:3px; margin-top:6px; min-width:0; }
  .act { margin-top:6px; font-family:var(--mono); font-size:10.5px; color:var(--faint);
         overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

  .noagent { font-family:var(--mono); font-size:10.5px; color:var(--faint); }
  .nrepos { font-family:var(--mono); font-size:10px; color:var(--faint); }

  .mchip { display:flex; align-items:center; gap:5px; font-family:var(--mono); font-size:10.5px;
           color:var(--muted); min-width:0; max-width:100%; }
  .mchip .r { color:var(--ink); flex:none; }
  /* The branch is the only elastic part: repo and ports are short and identifying, so
     they hold their width and the branch takes the truncation. */
  .mchip .br { color:var(--faint); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1 1 auto; min-width:0; }
  .mchip .p { color:var(--done); flex:0 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

  .badge { font-family:var(--mono); font-size:10px; font-weight:600; padding:1px 6px; border-radius:999px; flex:none; }
  .badge.merged { color:var(--done); background:var(--done-bg); }
  .badge.slot { color:var(--working); background:var(--working-bg); }
  .src { font-family:var(--mono); font-size:9px; text-transform:uppercase; letter-spacing:.05em;
         border:1px solid var(--border); border-radius:5px; padding:1px 5px; color:var(--muted); flex:none; }
</style>
