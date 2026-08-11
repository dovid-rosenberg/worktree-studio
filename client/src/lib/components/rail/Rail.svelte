<script lang="ts">
/*
 * The rail: repo filter, one flat list, count footer.
 *
 * ONE ROW PER THING. This used to be four sections — Servers running, Servers · no
 * worktree, Agents · no worktree, Worktrees — and a feature with a dev server up
 * appeared in two of them. The justification (fleet/ServerRow: "when servers are
 * running, this is the section you watch, so the browse buttons belong here too")
 * expired when every action moved to the ActionBar: the duplicate carried no buttons,
 * so it was the same readout drawn twice.
 *
 * NO BUCKETS. "Running" conflates two unrelated facts — dev servers up, and agent
 * state — so a section keyed on it would file a *waiting* agent, the one row that
 * actually wants the user, among worktrees untouched for a month. Instead every row
 * sorts on `active` and a single divider marks where the quiet ones start.
 *
 * That also retires four `position:sticky; top:0` headers sharing one scroller, which
 * collided as you scrolled past them.
 *
 * Keyed by `row.key` so a `session-state` frame mutates text nodes and class lists and
 * touches nothing else: scroll position and the focus ring on a card both survive.
 */
import AppHead from '$lib/components/rail/AppHead.svelte';
import FeatureCard from '$lib/components/rail/FeatureCard.svelte';
import MainServerCard from '$lib/components/rail/MainServerCard.svelte';
import SessionCard from '$lib/components/rail/SessionCard.svelte';
import ReviewCard from '$lib/components/rail/ReviewCard.svelte';
import { RAIL_SORTS, ui, liveMembers } from '$lib/stores/ui.svelte.js';
import type { RailSort } from '$lib/stores/ui.svelte.js';
import { world } from '$lib/stores/world.svelte.js';
import { overlays } from '$lib/stores/overlays.svelte.js';
import { groupSplitFeature } from '$lib/ops.svelte.js';
import StateDot from '$lib/components/StateDot.svelte';

const rows = $derived(ui.railRows);
const dividerAt = $derived(ui.dividerAt);
const reviewsAt = $derived(ui.reviewsAt);
const quiet = $derived(dividerAt < 0 ? 0 : rows.length - dividerAt);

/*
 * The fleet summary, moved down from the top bar to sit beside the rows it counts.
 *
 * TWO VOCABULARIES, SAID SEPARATELY. `running` counts dev SERVERS; `working` and
 * `waiting` count AGENTS. Printed as one comma-run they read as parts of one total and
 * then fail the arithmetic, so each group names what it counts.
 *
 * Servers are per WORKTREE (each runs its own). Agents are per SESSION — counting them
 * per member inflated the numbers by exactly how multi-repo the work was.
 */
const running = $derived(world.features.flatMap((f) => liveMembers(f)).filter((m) => m.running).length);
const working = $derived(world.sessions.filter((s) => s.state === 'working').length);
const waiting = $derived(world.sessions.filter((s) => s.state === 'waiting').length);
</script>

<aside class="rail">
  <!-- The fleet's own controls, at the head of the column that IS the fleet. They were a
       full-width band above everything; the dock's bar acts on one selection, so stacking
       the two put two different scopes in two identical-looking stripes. -->
  <AppHead />

  <!-- The verb that creates what this list contains, at the head of the list. It used to
       sit in the top bar, on the other side of the app from its result. -->
  <div class="rail-new">
    <button class="btn primary block" onclick={() => overlays.openIntake()}>＋ New session</button>
  </div>

  <div class="rail-head">
    <span id="rail-label">Work</span>
    <!-- Matches on any MEMBER repo: filtering to one repo must not split a BE+FE feature. -->
    <select class="mini-select" bind:value={ui.repoFilter} title="Filter by repo" aria-label="Filter by repo">
      <option value="">all repos</option>
      {#each ui.repoNames as n (n)}<option value={n}>{n}</option>{/each}
    </select>
    <!-- Beside the filter, because they are the same kind of control: both change what
         this list shows you without changing anything about the work. The choice
         persists — it is a working preference, not a per-visit whim. -->
    <select
      class="mini-select"
      value={ui.railSort}
      onchange={(e) => ui.setRailSort(e.currentTarget.value as RailSort)}
      title="Sort the list"
      aria-label="Sort the list"
    >
      {#each RAIL_SORTS as s (s.id)}<option value={s.id} title={s.hint}>{s.label}</option>{/each}
    </select>
  </div>

  <div class="rail-list" role="list" aria-labelledby="rail-label">
    {#if !rows.length}
      <!-- Two different empty states, because they have two different fixes.
           "No repos at all" means Studio is pointed at a folder that does not exist or
           holds no git repositories — the default `~/code` is a guess, not a convention.
           Telling that user to "start a session" sends them into an empty dropdown and
           an `unknown repo ''`, implying they did something wrong. -->
      {#if !world.repos.length}
        <div class="rail-empty">
          <b>No repositories found.</b>
          Studio scans your repo folders for git checkouts and found none. Set the folders
          in <button class="linkish" onclick={() => overlays.openSettings()}>Settings</button>.
        </div>
      {:else}
        <!-- The button is directly above, so the copy no longer has to point at it. -->
        <div class="rail-empty">
          Nothing here yet. Start a session above, or promote one to create a worktree.
        </div>
      {/if}
    {/if}

    <!-- Worktrees that are one piece of work under two names. Above the list because it
         is a claim about the list itself: two of the cards below are half a feature each,
         and nothing on either card could say so. -->
    {#each world.splitFeatures.filter((f) => ui.splitVisible(f)) as f (f.branch)}
      <div class="split">
        <div class="split-t">Same branch, two features</div>
        <div class="split-b"><span class="br">{f.branch}</span> is split across {f.features.join(' + ')}</div>
        <div class="split-a">
          <button class="btn sm" onclick={() => groupSplitFeature(f)}>Group them</button>
          <!-- A finding you can disagree with. Two worktrees on one branch is sometimes
               deliberate — a spike beside the real work — and without this the banner
               restates itself on every topology frame for as long as both exist. -->
          <button class="linkish" onclick={() => ui.dismissSplit(f)}>Not the same work</button>
        </div>
      </div>
    {/each}

    {#each rows as row, i (row.key)}
      {#if i === dividerAt}
        <div class="divider"><span>idle · {quiet}</span></div>
      {/if}
      <!-- The SECOND divider, and the only place the rail groups by kind.
           Everything above is work you started; everything below is somebody else's,
           waiting on you. The sort orders each side; it does not decide the split, so
           choosing a different sort cannot scatter the reviews back through your work. -->
      {#if i === reviewsAt}
        <div class="divider rev"><span>waiting on you · {ui.reviewRows.length}</span></div>
      {/if}
      {#if row.kind === 'feature'}
        <FeatureCard feature={row.feature} />
      {:else if row.kind === 'session'}
        <SessionCard session={row.session} />
      {:else if row.kind === 'review'}
        <ReviewCard review={row.review} />
      {:else}
        <MainServerCard worktree={row.worktree} />
      {/if}
    {/each}
  </div>

  <!-- Counts what is drawn, then the fleet summary. The row count used to say
       "N feature(s)" while the list also held sessions and main-checkout servers, so the
       number never matched the rows. Zeros are hidden: a zero takes the same space as a
       real count and says nothing. -->
  <div class="rail-foot">
    <div class="foot-rows">{rows.length} row(s){quiet ? ` · ${quiet} idle` : ''}</div>
    {#if working || waiting || running}
      <div class="foot-counts">
        <!-- The dot carries the whole phrase and the text beside it is hidden from
             assistive tech: the swatch and the label are one fact, and announcing both
             reads it twice. -->
        {#if working}<span class="c"><StateDot state="working" label="{working} agents working" /><span aria-hidden="true">{working} working</span></span>{/if}
        {#if waiting}<span class="c"><StateDot state="waiting" label="{waiting} agents waiting on you" /><span aria-hidden="true">{waiting} waiting</span></span>{/if}
        {#if running}<span class="c"><StateDot state="done" label="{running} dev servers up" /><span aria-hidden="true">{running} up</span></span>{/if}
      </div>
    {/if}
  </div>
</aside>

<style>
  .rail { border-right:1px solid var(--border); background:var(--panel); display:flex; flex-direction:column; min-height:0; }
  .rail-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:12px 14px; font-family:var(--mono); font-size:11.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--faint); border-bottom:1px solid var(--border); }
  /* overflow-x:hidden is load-bearing: a long branch name must truncate inside its card,
     never widen the rail into a horizontal scrollbar. */
  .rail-list { flex:1; overflow-y:auto; overflow-x:hidden; padding:8px 0; display:flex; flex-direction:column; }
  .rail-new { padding:10px 12px 0; }
  .rail-new .block { width:100%; }

  .rail-foot { padding:9px 14px; border-top:1px solid var(--border); font-family:var(--mono); font-size:11.5px; color:var(--faint); display:flex; flex-direction:column; gap:5px; }
  .rail-foot .foot-counts { display:flex; flex-wrap:wrap; gap:9px; }
  .rail-foot .c { display:inline-flex; align-items:center; gap:5px; }
  /* A finding, not an error: it states something true and offers the one action that
     resolves it. Warning-toned rather than red — nothing is broken, it is just split. */
  .split { margin:6px 10px 10px; padding:9px 11px; border:1px solid var(--border); border-left:2px solid var(--working);
           border-radius:7px; background:var(--panel-2, transparent); display:flex; flex-direction:column; gap:5px; align-items:flex-start; }
  .split .split-t { font-family:var(--mono); font-size:10.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--working); }
  .split .split-b { font-size:12px; color:var(--muted); line-height:1.45; }
  .split .br { font-family:var(--mono); color:var(--fg); }
  .split .split-a { display:flex; align-items:center; gap:10px; }
  /* The dismissal is deliberately the quieter of the two: grouping is the answer this
     banner is arguing for, and disagreeing with it should not look like the primary. */
  .split .split-a .linkish { font-size:11.5px; color:var(--muted); text-decoration:none; }
  .split .split-a .linkish:hover { color:var(--fg); text-decoration:underline; }

  .rail-empty { padding:14px; font-family:var(--mono); font-size:11.5px; color:var(--faint); }
  .rail-empty b { display:block; color:var(--ink); margin-bottom:4px; }
  /* A button that reads as a link: it opens the modal that fixes the problem the
     sentence just described, and sending someone hunting for Settings instead is the
     dead end this empty state exists to end. */
  .linkish { background:none; border:0; padding:0; font:inherit; color:var(--brand);
             text-decoration:underline; cursor:pointer; }

  /* A hairline, not a header: it separates, it does not label a category. Deliberately
     not sticky — the four sticky headers it replaces used to pile up on each other. */
  .divider { display:flex; align-items:center; gap:9px; margin:6px 12px 8px; }
  .divider::after { content:''; flex:1; height:1px; background:var(--border); }
  .divider span { font-family:var(--mono); font-size:10.5px; letter-spacing:.09em; text-transform:uppercase; color:var(--faint); }
  /* The one divider that marks a change of KIND rather than of activity, so it is the
     one that carries a colour. */
  .divider.rev span { color:var(--done); }
  .divider.rev::after { background:var(--done); opacity:.35; }
</style>
