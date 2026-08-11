<script lang="ts">
import type { Session } from '../../../../../server/types';
/*
 * One UNPROMOTED session in the rail — an agent with no worktree, and therefore no
 * feature to sit under. Promoted sessions are drawn by FeatureCard instead, since the
 * rail is keyed on features now.
 *
 * Like FeatureCard, this is a fixed-height readout with no buttons: Promote, Resume and
 * Delete all live in the bottom ActionBar. Hover-revealed actions used to grow the card
 * and reflow the rows below it, which made the list move under the pointer.
 *
 * The whole point of the port lives here: this card is rendered once per session and
 * then *updated in place* as frames arrive. app.js rebuilt the entire rail with
 * `rail.innerHTML = ''` on every SSE tick — i.e. several times a second while a
 * session is working — which destroyed focus, scroll position and any open menu.
 */
import { ui, labelForSource, selectionKey } from '$lib/stores/ui.svelte.js';
import { world, quietFor, quietLabel } from '$lib/stores/world.svelte.js';
import StateDot from '$lib/components/StateDot.svelte';

let { session }: { session: Session } = $props();

/** The ⌥ digit that selects this row — see ui.railDigits for why it is shown. Built
    through selectionKey rather than an `s:` literal: one spelling of the scheme. */
const digit = $derived(ui.railDigits.get(selectionKey({ kind: 'session', id: session.id })));

const stopped = $derived(session.state === 'stopped');
const srv = $derived((world.servers[session.id] && world.servers[session.id].repos) || []);
const running = $derived(srv.filter((r) => r.running));
const ports = $derived(running.flatMap((r) => r.ports || []));
const selected = $derived(ui.selectedId === session.id);
const reps = $derived(session.repos && session.repos.length ? session.repos : [{ repo: session.repoName }]);

/*
 * How long this card's status has been unverified — 0 while it is still believable.
 *
 * Without this the card states what the LAST hook said and never states how old that is,
 * so a session whose hooks stopped firing reads `working · running Bash` indefinitely and
 * looks exactly like one that is working. reconcile() cannot cover it: the tmux window is
 * still alive in every one of these cases. See quietFor for the threshold and its basis.
 */
const quiet = $derived(quietFor(session, world.now));
</script>

<div class="railcard scard" class:sel={selected} class:running={running.length > 0} class:stoppedrow={stopped} role="listitem">
  <button
    class="hit"
    onclick={() => ui.select(session.id)}
    aria-pressed={selected}
    aria-label="Select session {session.title}"
  >
    <div class="top">
      <StateDot state={session.state} />
      <span class="title">{session.title}</span>
      {#if digit}<span class="digit" title="⌥{digit} selects this">⌥{digit}</span>{/if}
      {#if running.length}
        <span class="pill run" title="Dev servers running{ports.length ? ` — :${ports.join(' :')}` : ''}">
          <span class="pi">⇅</span>running
        </span>
      {:else}
        <span class="pill {session.state}">{session.state}</span>
      {/if}
      <!-- Beside the state pill, not instead of it: the last report is still the best
           guess at what the agent was doing, and this says only that it has aged out. -->
      {#if quiet}
        <span
          class="pill stale"
          title="No hook event for {quietLabel(quiet)} — the state and activity shown are what the agent LAST reported, not what it is doing now. Its hooks may have stopped firing."
        >no signal {quietLabel(quiet)}</span>
      {/if}
    </div>
    <div class="meta">
      <span class="src">{session.source}</span>
      {#if session.sourceUrl}
        <!-- A real link, so a click must not also select the card. -->
        <a
          class="link"
          href={session.sourceUrl}
          target="_blank"
          rel="noreferrer"
          onclick={(e) => e.stopPropagation()}
        >{labelForSource(session)}</a>
      {/if}
      {#each reps as r (r.repo)}<span class="grp">{r.repo}</span>{/each}
    </div>
    <div class="act">{session.activity || ''}</div>
  </button>
</div>

<style>
  /* The shell — border, radius, background, margin, hover, `.sel`, the whole-card button
     and the ⌥ digit — is `.railcard` in app.css. Only what a SESSION card adds is here. */
  .scard.running { box-shadow:inset 3px 0 0 var(--done); }
  /* Dimmed, not hidden: a stopped agent is still resumable and must stay findable. */
  .scard.stoppedrow .title, .scard.stoppedrow .meta { opacity:.55; }

  /* `waiting`'s amber, because that is what this is: something is blocked on YOU going
     and looking. Not `--del` — nothing has failed for certain, the report is only old. */
  .pill.stale { color:var(--waiting); background:var(--waiting-bg); }

  .top { display:flex; align-items:center; gap:8px; min-width:0; }
  .title { font-weight:600; font-size:14px; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .meta { display:flex; align-items:center; gap:7px; margin-top:6px; font-family:var(--mono); font-size:11.5px;
          color:var(--muted); flex-wrap:wrap; }
  .act { margin-top:6px; font-family:var(--mono); font-size:11.5px; color:var(--faint);
         overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
</style>
