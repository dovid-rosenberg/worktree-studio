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
 * The merged mark moved rather than went: it sat in the card's CORNER, driven by
 * `some(merged)`, so on a four-repo feature it could mean one of four and a half-landed
 * feature read as done. It now sits next to the branch it is about.
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
import { colorVars } from '$lib/featureColor.js';
import { world, quietFor, quietLabel } from '$lib/stores/world.svelte.js';
import { ui, liveMembers, selectionKey } from '$lib/stores/ui.svelte.js';
import StateDot from '$lib/components/StateDot.svelte';

let { feature }: { feature: Feature } = $props();

const ms = $derived(liveMembers(feature));
const anyRunning = $derived(ms.some((m) => m.running));
const sess = $derived(feature.session); // one session per feature

/*
 * What you called it wins over what the directory is called.
 *
 * `feature.name` is the WORKTREE name — the identity that groups repos, which cannot
 * change without moving directories. Renaming a session sets `session.title`, and this
 * card showed only `feature.name`, so a rename saved to disk and changed nothing here.
 * A title that still equals the worktree name is the default and adds nothing, so the
 * second line appears only once they have actually diverged.
 */
/* Through selectionKey, not a `f:` literal: railDigits is keyed on the row key, and a
   prefix spelled twice is a lookup that silently misses when one of them changes. */
const digit = $derived(ui.railDigits.get(selectionKey({ kind: 'feature', name: feature.name })));
/*
 * repo → its MR tag, for the member rows.
 *
 * On the row rather than the card, because a merge request is a fact about ONE repo's
 * branch. Not a link: the rail is a pure readout with no controls, and that rule is
 * worth more than saving a click — the absence on a row is the useful part anyway.
 */
const prTags = $derived(
  new Map(
    world
      .linksFor(feature)
      .filter((l) => l.kind === 'pr' && !l.empty && l.repo)
      .map((l) => [l.repo as string, l.label.split(' ').pop() || '']),
  ),
);
const label = $derived(sess?.title?.trim() || feature.name);
const renamed = $derived(label !== feature.name);
/** Members whose start command cannot succeed — no node_modules in the worktree. */
const noDeps = $derived(ms.filter((m) => m.depsMissing).length);
const noStart = $derived(ms.filter((m) => m.noStartCmd).length);

const selected = $derived(sess ? ui.selectedId === sess.id : ui.selectedFeatureName === feature.name);

/**
 * An agent state worth a label. `idle` is the resting state and `stopped` is covered
 * by the dimmed dot, so neither earns a pill — only working/waiting do, which is what
 * makes `waiting` findable.
 */
const notable = $derived(!!sess && sess.state !== 'idle' && sess.state !== 'stopped');
/*
 * How long this feature's agent has been silent, when that has stopped meaning anything
 * good. A promoted session is drawn here rather than by SessionCard, so without this the
 * staleness warning existed for exactly the sessions that had not been promoted yet —
 * the least interesting half.
 */
const quiet = $derived(sess ? quietFor(sess, world.now) : 0);

/*
 * How far this branch has drifted from its base — server/overlap.ts.
 *
 * Quiet by design, and only past a threshold: it is a condition to notice while
 * scanning, not an alarm. A card that shouts every time you look at it stops being read,
 * and a branch one commit behind is simply fine.
 */
const lap = $derived(world.overlapFor(feature.name));
const behind = $derived((lap?.behind || 0) >= 5 ? lap!.behind : 0);
</script>

<div style={colorVars(feature.color)} class="railcard fcard" class:sel={selected} class:running={anyRunning} role="listitem">
  <button
    class="hit"
    onclick={() => ui.selectFeature(feature)}
    aria-pressed={selected}
    aria-label="Select feature {label}"
  >
    <div class="l1">
      <!-- The one mount where the name is load-bearing: the pill below is suppressed for
           idle and stopped, so for those two states this dot is the whole signal. -->
      {#if sess}
        <StateDot state={sess.state} />
      {:else}
        <StateDot
          state={anyRunning ? 'done' : 'idle'}
          label={anyRunning ? 'No agent, dev servers running' : 'No agent'}
        />
      {/if}
      <span class="fname">{label}</span>
      <!-- The ⌥ digit that selects this row — see .railcard .digit in app.css. -->
      {#if digit}<span class="digit" title="⌥{digit} selects this">⌥{digit}</span>{/if}
      {#if !feature.auto}<span class="src" title="Grouped by config.groups, not by name">manual</span>{/if}
      {#if feature.slot != null}
        <span class="badge slot" title="Concurrency slot — its ports are offset by slot·100">{feature.slot}</span>
      {/if}
    </div>

    <!-- Only what is not the default. An idle agent and stopped servers say nothing;
         their absence says it without spending a row of attention on it. -->
    {#if notable || quiet || noDeps || renamed || ms.length > 1 || !sess || behind}
      <div class="l2">
        {#if sess && notable}
          <span class="pill agent {sess.state}" title="The Claude session driving this feature">{sess.state}</span>
        {/if}
        {#if quiet}
          <span
            class="pill stale"
            title="No hook event for {quietLabel(quiet)} — the state and activity shown are what the agent LAST reported, not what it is doing now. Its hooks may have stopped firing."
          >no signal {quietLabel(quiet)}</span>
        {/if}
        {#if !sess}<span class="nosession">no session</span>{/if}
        {#if noDeps}
          <span class="pill nodeps" title="{noDeps} of {ms.length} worktree(s) have no node_modules — their dev server cannot start until deps are installed">deps missing</span>
        {/if}
        {#if noStart}
          <span class="pill nostart" title="{noStart} of {ms.length} worktree(s) have no start command in config.start — add one to run their dev server">no start cmd</span>
        {/if}
        {#if renamed}<span class="wtname" title="The worktree name — what groups these repos">{feature.name}</span>{/if}
        {#if ms.length > 1}<span class="nrepos">{ms.length} repos</span>{/if}
        {#if behind}
          <span class="pill behind" title="This branch is {behind} commit(s) behind its base">behind {behind}</span>
        {/if}
      </div>
    {/if}

    <div class="l3">
      {#each ms as m (m.path)}
        <span class="mchip">
          <span class="r">{m.repo}</span>
          <!-- Left of the branch it is ABOUT. It used to be one ✓ in the card's corner,
               set by `some(merged)` — so on a four-repo feature it could mean one of four,
               and a half-landed feature read as done. Per branch, it cannot. -->
          {#if m.merged}<span class="mrg" title="{m.branch || m.wtname} is merged into its base">✓</span>{/if}
          <span class="br" class:done={m.merged}>{m.branch || m.wtname}</span>
          {#if prTags.get(m.repo)}<span class="pr">{prTags.get(m.repo)}</span>{/if}
          {#if (m.ports || []).length}
            <!-- Off-slot: listening, but on none of the ports this feature's slot expects
                 — a server started outside Studio, or one whose start command ignored the
                 slot env. It is sitting on the port the next feature will ask for, so the
                 ports read as a warning rather than as confirmation. -->
            <span
              class="p"
              class:offslot={(m.offSlot || []).length}
              title={(m.offSlot || []).length
                ? `not on this feature's slot ports — started outside Studio, or the start command ignored the slot`
                : undefined}
            >{m.ports.map((p: number) => ':' + p).join(' ')}</span>
          {/if}
          <!-- Shared node_modules: a symlink out of the worktree, so this row is not
               isolated from the other worktrees of its repo. Marked whether or not a
               server is up — the damage (a shared Vite dep cache, an install that
               rewrites everyone's tree) is not conditional on this one running. -->
          <!-- Which backend this frontend's config actually points at.
               `offSlot` above is about a socket; this is about a FILE Studio rewrites
               and, until now, never read back. A frontend patched to :1439 while the
               process on 1439 belongs to another feature's branch looks perfectly
               healthy from every other signal on this card — that is the state this
               chip exists to make visible, so it is the one that is loud. -->
          {#if m.wiredTo}
            <span
              class="wired {m.wiredTo.status}"
              title={m.wiredTo.status === 'foreign'
                ? `WRONG BACKEND — :${m.wiredTo.port} is served by feature '${m.wiredTo.feature}'${m.wiredTo.repo ? ` (${m.wiredTo.repo})` : ''} at ${m.wiredTo.path}. This frontend's config points there, so its API calls hit that branch's code: expect 404s on routes this branch has and that one does not. Start this feature's backend and restart this frontend to re-patch the config.`
                : m.wiredTo.status === 'mine'
                  ? `API config points at :${m.wiredTo.port} — this feature's own backend`
                  : m.wiredTo.status === 'dead'
                    ? `API config points at :${m.wiredTo.port}, where nothing is listening — every API call fails until this feature's backend is up`
                    : `API config names no backend port of the sibling repo — cannot tell what this frontend talks to`}
            >{m.wiredTo.status === 'foreign'
                ? `→ ${m.wiredTo.feature}:${m.wiredTo.port}`
                : m.wiredTo.status === 'unknown'
                  ? '→ ?'
                  : `→ :${m.wiredTo.port}`}</span
            >
          {/if}
          {#if m.sharedModules}
            <span
              class="shared"
              title="node_modules is a symlink to {m.sharedModules} — this worktree shares its dependency tree and every cache inside it (Vite's .vite/deps above all). Replace it with a real install: “Own deps” in the action bar."
            >⇄deps</span>
          {/if}
          <!--
            Stale dependencies: installed, resolvable, and OLDER than the lockfile that
            describes them. Beside ⇄deps because they are the same kind of claim — a fact
            about this checkout's node_modules, not about whether a server is up — and it
            is the one member-level condition where every other signal on the row is
            green. The card's "deps missing" pill cannot cover it: that pill means the
            server will not start, and this one starts and then misbehaves from inside a
            package nobody edited.
          -->
          {#if m.depsStale && !m.depsMissing}
            <span
              class="staledeps"
              title="node_modules is older than package-lock.json — this worktree is running the dependencies from before the last lockfile change. It will start, and then fail in ways that look like a bug in this branch. Install deps to resync."
            >⌛deps</span>
          {/if}
          <!--
            A dev server that DIED. Discovery is a map diff, so the only notice a crash
            used to give was the green edge quietly going away while nobody was looking at
            the rail — and the user found out from a 502 twenty minutes later, then blamed
            the frontend. A stop the user asked for is never marked (the server knows the
            difference), so this mark always means something went wrong on its own.
          -->
          {#if m.died}
            <span
              class="died"
              title="The dev server here stopped on its own at {new Date(m.died.at).toLocaleTimeString()} — it was listening on {(m.died.ports || []).map((p: number) => ':' + p).join(' ') || 'no port we saw'}{m.died.pid ? ` as pid ${m.died.pid}` : ''}, and nothing asked it to stop. Calls to those ports fail until it is started again; its log has the reason."
            >died</span>
          {/if}
        </span>
      {/each}
    </div>

    {#if sess && sess.activity}<div class="act">{sess.activity}</div>{/if}
  </button>
</div>

<style>
  /* The border, radius, margin, hover and whole-card button are `.railcard` in app.css.
     What is left here is what a FEATURE card alone has.

     `var(--fc, <default>)` IS the precedence rule, written once: a tagged feature wears
     its colour, an untagged one falls back to exactly what it looked like before. No
     conditional class, and nothing to keep in sync — --fc is set (or not) on this element
     by colorVars() and inherited by everything below.

     Qualified with `.railcard` so it outranks that rule's own `background` — a tagged
     card keeps its wash when selected, which is the whole point of the ring below. */
  .railcard.fcard { background:var(--fc-wash, var(--panel)); box-shadow:inset 3px 0 0 var(--fc, transparent); }
  /*
   * Selection needs a channel the colour tag is not already using.
   *
   * This was `background: var(--fc-wash, var(--elevated))` — which, for a TAGGED card,
   * resolves to the same wash the unselected card already has, so selecting it changed
   * the background not at all. The border went to `--fc`, a colour the card is already
   * wearing as its 3px edge. Net effect: opting into a colour tag made a card's selection
   * state WEAKER than an untagged one's, which is backwards.
   *
   * So selection is now a ring in the brand hue — never a feature colour, so it cannot
   * collide with the tag — plus a widened edge. Both read on a tagged and an untagged card.
   */
  .fcard.sel { border-color:var(--brand); box-shadow:inset 3px 0 0 var(--fc, var(--brand)), 0 0 0 1px var(--brand); }
  .fcard.sel.running { box-shadow:inset 3px 0 0 var(--fc, var(--done)), 0 0 0 1px var(--brand); }
  /* A tag OUTRANKS the running edge, deliberately: "servers up" is already said by the
     port numbers on the member rows, which render in --done and only exist while a server
     is up. Identity has no second copy, so it gets the channel. */
  .fcard.running { box-shadow:inset 3px 0 0 var(--fc, var(--done)); }

  .l1 { display:flex; align-items:center; gap:7px; min-width:0; }
  .fname { font-weight:600; font-size:14px; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .l2 { display:flex; align-items:center; gap:6px; margin-top:6px; flex-wrap:wrap; min-width:0; }
  .l3 { display:flex; flex-direction:column; gap:3px; margin-top:6px; min-width:0; }
  .act { margin-top:6px; font-family:var(--mono); font-size:11.5px; color:var(--faint);
         overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

  .nosession { font-family:var(--mono); font-size:11.5px; color:var(--faint); }
  /* Waiting-hue, not an error: it is a thing to do, not a thing that broke. */
  .pill.stale { color:var(--waiting); background:var(--waiting-bg); }
  .pill.nodeps { color:var(--waiting); background:var(--waiting-bg); }
  /* Same amber as deps: both say "configured wrong, not broken", and both are fixed
     by the user rather than by waiting. */
  .pill.nostart { color:var(--waiting); background:var(--waiting-bg); }
  /* Drift is a fact, not a fault — quiet, and bordered rather than filled. */
  .pill.behind { color:var(--faint); border:1px solid var(--border); }
  .nrepos { font-family:var(--mono); font-size:11px; color:var(--faint); }

  .mchip { display:flex; align-items:center; gap:5px; font-family:var(--mono); font-size:11.5px;
           color:var(--muted); min-width:0; max-width:100%; }
  .mchip .r { color:var(--ink); flex:none; }
  /* The branch is the only elastic part: repo and ports are short and identifying, so
     they hold their width and the branch takes the truncation. */
  /* Merged: the branch itself goes green, so the row reads as done at a glance rather
     than needing you to decode a mark. */
  .wtname { font-family:var(--mono); font-size:10.5px; color:var(--faint); overflow:hidden;
            text-overflow:ellipsis; white-space:nowrap; max-width:60%; }
  .mchip .mrg { color:var(--done); flex:none; font-size:11px; }
  .mchip .br { color:var(--faint); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1 1 auto; min-width:0; }
  .mchip .br.done { color:var(--done); }
  .pr { color:var(--brand); flex:none; }
  .mchip .p { color:var(--done); flex:0 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  /* Same ports, different claim: these are the ones it should NOT be on. */
  .mchip .p.offslot { color:var(--warn, var(--working)); text-decoration:underline dotted; }
  /* Not a port and not a state — a property of the checkout, so it sits apart from
     both and holds its width rather than competing with the branch for space. */
  .mchip .shared { color:var(--warn, var(--working)); flex:none; cursor:help; }
  /* Same hue and weight as ⇄deps: both are properties of this checkout's node_modules
     that the user fixes with an install, and neither stops anything from running.
     `.staledeps` rather than `.stale` because `.pill.stale` on this same card already
     means "the agent has gone quiet" — one class name for two conditions is how a
     stylesheet comes to say something it did not mean. */
  .mchip .staledeps { color:var(--warn, var(--working)); flex:none; cursor:help; }
  /*
   * A server that died is the loudest thing a member row can say, and it earns it.
   *
   * Every other mark here is a condition you can take your time over. This one is the
   * only one that means something that WAS working has stopped, with nothing on screen
   * having changed to say so — the failure the mark exists for is precisely that it went
   * unnoticed. So it is filled, in the same red as a foreign backend, rather than
   * competing quietly with the amber conditions beside it.
   */
  .mchip .died { color:var(--del); background:var(--del-bg); font-weight:600;
                 padding:0 5px; border-radius:999px; flex:none; cursor:help; }

  /*
   * Where this frontend's API calls actually go.
   *
   * Correct is nearly silent — `→ :1239` in the faint hue, the same weight as the branch
   * text. It is confirmation, and confirmation that shouts is confirmation nobody reads.
   *
   * WRONG is the exception in this file, and on purpose. Every other mark on this card is
   * unfilled text; this one is the only FILLED chip on a member row, in the delete red
   * that nothing else on the rail wears, and it spells the other feature's name inline
   * rather than hiding it in the tooltip. The failure it names is the one that is
   * invisible by construction — the frontend is up, the backend is up, the ports match
   * what the config says, and the answers come from the wrong branch. Nothing quieter
   * would have beaten the four green signals sitting next to it.
   */
  .mchip .wired { flex:none; cursor:help; }
  .mchip .wired.mine { color:var(--faint); }
  .mchip .wired.foreign { color:var(--del); background:var(--del-bg); font-weight:600;
                          padding:0 5px; border-radius:999px; max-width:100%;
                          overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:0 1 auto; }
  /* Amber, not red: nothing is listening there, so the calls fail loudly and nobody is
     misled. A thing to start, not a thing that lied to you. */
  .mchip .wired.dead { color:var(--waiting); }
  /* "I read the file and recognised nothing" — the honest non-answer, and it is styled
     like one rather than like a verdict. */
  .mchip .wired.unknown { color:var(--idle); }

  .badge { font-family:var(--mono); font-size:11px; font-weight:600; padding:1px 6px; border-radius:999px; flex:none; }
  .badge.slot { color:var(--working); background:var(--working-bg); }
  /* `.src` itself is a global token (app.css, beside .grp and .link). It was re-declared
     here at a size of its own, which is how one token came to render at three sizes. */
  .src { flex:none; }
</style>
