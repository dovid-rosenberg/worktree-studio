<script lang="ts">
  /*
   * The dock: header, tab strip, the live terminal, the DOM panels,
   * and the server bar.
   *
   * Structural rule, carried straight over from app.js: switching to Changes/Logs/
   * Insights HIDES the terminal area, it does not unmount it. A tmux pane is cheap to
   * hide and expensive to reattach — unmounting would drop the socket, reset the
   * buffer, and make every tab switch cost a redraw. `active` tells the Terminal it is
   * hidden so it stops fitting against a 0×0 box.
   */
  import { colorVars } from '$lib/featureColor.js';
  import Terminal from '$lib/components/Terminal.svelte';
  import ActionBar from '$lib/components/ActionBar.svelte';
  import LinkChip from '$lib/components/LinkChip.svelte';
  import DockHead from '$lib/components/dock/DockHead.svelte';
  import TabStrip from '$lib/components/dock/TabStrip.svelte';
  import LogsPanel from '$lib/components/dock/LogsPanel.svelte';
  import RunsPanel from '$lib/components/dock/RunsPanel.svelte';
  import ReviewMount from '$lib/components/dock/ReviewMount.svelte';
  import FeaturePane from '$lib/components/dock/FeaturePane.svelte';
  import ReviewPane from '$lib/components/dock/ReviewPane.svelte';
  import FleetInsights from '$lib/components/insights/FleetInsights.svelte';
  import { api } from '$lib/api.js';
  import { ui } from '$lib/stores/ui.svelte.js';
  import { world } from '$lib/stores/world.svelte.js';
  import { overlays } from '$lib/stores/overlays.svelte.js';

  const session = $derived(ui.selected);
  const feature = $derived(ui.selectedFeature);
  /** A dev server in a repo's MAIN checkout — the third kind of rail row. */
  const mainServer = $derived(ui.selectedMainServer);
  /** A merge request awaiting review — the fourth kind of rail row. */
  const review = $derived(ui.selectedReview);
  const isTerm = $derived(ui.dockView === 'term');
  /*
   * Insights is the one dock view that renders with nothing selected: it is about the
   * whole fleet, not the selection. (Overview used to be the other; it was the rail
   * drawn wide, so it went when the rail became one honest list.)
   */
  const isUsage = $derived(ui.dockView === 'usage');

  /*
   * `session` is a NEW object on every session-state frame — the store derives the world
   * from two pristine halves rather than patching one in place, which is what makes the
   * stitching safe. The cost is that anything downstream depending on the object itself
   * invalidates several times a second.
   *
   * These two `$derived`s are the firebreak. A derived only propagates when its value
   * changes by `===`, so a string id stays stable across frames, and an `$effect` in a
   * child that reads it does not re-run. Without them the Terminal's socket effect
   * re-ran per frame and opened a fresh WebSocket per Claude tool call — measured, not
   * theorised: 10 frames produced 10 sockets, and each one's onopen stole focus.
   */
  const sessionId = $derived(session?.id ?? '');
  const hasWorktree = $derived(!!session?.worktreePath);

  /**
   * Uncommitted-file count for the ✎ Changes badge. Fetched here rather than in the
   * review panel so the badge has a number before the tab is ever opened — the same
   * eager load rebuildDock() did. Refreshed, debounced, while the panel is open.
   */
  let changesCount = $state(0);

  $effect(() => {
    const id = sessionId;
    if (!id || !hasWorktree) { changesCount = 0; return; }
    // Depend on the session list ONLY while Changes is open, so a frame schedules a
    // refresh there and nowhere else; 400 ms of debounce keeps a busy agent from
    // issuing a git call per tool use.
    if (ui.dockView === 'changes') void world.sessions;
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const data = await api('GET', `/api/v1/sessions/${id}/commits`);
        if (!alive) return;
        changesCount = (data.repos || []).reduce(
          (n: number, r: { uncommitted?: { fileCount?: number } }) => n + (r.uncommitted?.fileCount || 0),
          0,
        );
      } catch { /* a git failure must not take the tab strip with it */ }
    }, 400);
    return () => { alive = false; clearTimeout(t); };
  });
</script>

<section class="dock" style={colorVars(world.featureColorFor(sessionId))}>
  {#if isUsage}
    <FleetInsights />
  {:else if feature}
    <!-- A feature has no DockHead, so the bar is rendered here. ActionBar has exactly one
         home per selection kind: DockHead's row for a session, this for a feature. -->
    <div class="dockbar">
      <span class="who">{feature.name}</span>
      <!-- The ticket and merge-request chips, which used to render ONLY in DockHead —
           i.e. only for a feature that has a session. links.ts states the fix outright:
           "a feature with no session had neither". This is the surface that made that
           still true, and it is exactly the feature you are most likely to want a ticket
           link for, since nobody has started work on it yet. -->
      {#each world.linksFor(feature) as l (l.kind + l.label)}<LinkChip link={l} />{/each}
      <span class="grow"></span>
      <ActionBar />
    </div>
    <FeaturePane {feature} />
  {:else if review}
    <!-- A review has no worktree, so no DockHead, no tabs and no terminal — the pane is
         the whole thing until you check it out, at which point it becomes an ordinary
         session row and this branch stops applying. -->
    <div class="dockbar">
      <span class="who">{review.repo} !{review.number}</span>
      <span class="wtname">awaiting your review</span>
      <span class="grow"></span>
    </div>
    <ReviewPane {review} />
  {:else if ui.selectionPending}
    <!-- Selected, but the frame carrying it has not landed. Saying "no session" here
         is what made starting an agent look like a no-op. -->
    <div class="empty">
      <div class="empty-glyph">⎇</div>
      <h2>Starting the session…</h2>
      <p>Waiting for the daemon to report it. This is usually instant.</p>
    </div>
  {:else if mainServer}
    <div class="dockbar">
      <span class="who">{mainServer.repo}</span>
      <span class="wtname">main checkout</span>
      <span class="grow"></span>
      <ActionBar />
    </div>
    <div class="empty">
      <div class="empty-glyph">⇅</div>
      <h2>{mainServer.repo}</h2>
      <p>
        A dev server running from this repo&rsquo;s main checkout, outside any worktree.
        {#if mainServer.ports.length}Listening on {mainServer.ports.map((p) => `:${p}`).join(' ')}.{/if}
      </p>
    </div>
  {:else if !session}
    <div class="empty">
      <div class="empty-glyph">⎇</div>
      <h2>No session selected</h2>
      <p>
        Start one from any source — free text, a GitHub / GitLab issue, or an Asana task. It boots a
        real Claude&nbsp;Code session on your CLAUDE.md, and you promote it to a worktree when
        it&rsquo;s real work.
      </p>
      <div class="empty-cta">
        <button class="btn primary" onclick={() => overlays.openIntake()}>+ New session</button>
        <button class="btn" onclick={() => ui.setDockView('usage')}>◔ Insights</button>
      </div>
    </div>
  {:else}
    <DockHead {session} />
    <TabStrip {session} {changesCount} />

    <!-- Hidden, never unmounted: see the note at the top of this file. -->
    <div class="term-area" hidden={!isTerm}>
      <!-- `revive` flips when the agent comes back, which is what tells a pane whose
           socket closed on a dead multiplexer session to attach again. -->
      <Terminal {sessionId} active={isTerm} revive={session.active === false ? 0 : 1} />
    </div>

    {#if ui.dockView === 'changes'}
      <ReviewMount {session} />
    {:else if ui.dockView === 'logs'}
      <LogsPanel {session} />
    {:else if ui.dockView === 'runs'}
      <RunsPanel {session} />
    {/if}

  {/if}
</section>

<style>
  .dock { display:flex; flex-direction:column; min-height:0; min-width:0; }
  /* The same bar DockHead draws, for the selections that have no DockHead. */
  .dockbar { display:flex; align-items:center; gap:10px; padding:12px 16px; flex:none; flex-wrap:wrap;
             border-bottom:1px solid var(--border); background:var(--fc-wash, var(--panel));
             box-shadow:inset 4px 0 0 var(--fc, transparent); }
  .dockbar .who { font-weight:650; font-size:16px; }
  /* Wrap rather than overflow: a four-repo feature's chips must not push the verbs off. */
  .dockbar { row-gap:6px; }
  .dockbar .wtname { font-family:var(--mono); font-size:11.5px; color:var(--faint); }
  .dockbar .grow { flex:1; }
  .empty { margin:auto; text-align:center; max-width:440px; padding:40px; color:var(--muted); }
  .empty-glyph { font-size:40px; color:var(--border-strong); }
  .empty h2 { margin:12px 0 6px; color:var(--ink); font-size:20px; }
  .empty p { font-size:15px; line-height:1.55; }
  .empty-cta { display:flex; gap:8px; justify-content:center; margin-top:16px; }

  .term-area { flex:1; min-height:0; min-width:0; display:flex; flex-direction:column; }
</style>
