<script lang="ts">
  /*
   * The action bar: every action for whatever is selected, pinned along the bottom of
   * the screen.
   *
   * It replaces the hover-reveal quick actions the rail cards used to carry. Those
   * expanded the card on hover, which reflowed every row below it — so moving the mouse
   * down the rail made the list jump under the cursor, and the row you were aiming at
   * moved before you clicked it. A fixed bar cannot do that: it occupies the same space
   * whether or not anything is selected, and the rail stays geometrically still.
   *
   * It handles both selection kinds, because both need the same verbs. A feature with no
   * agent simply has fewer of them.
   *
   * ONE VERB FOR STARTING DEV SERVERS. This used to show `Run servers` / `Stop servers`
   * beside `Run stack` / `Stop stack` for a promoted session. They target the SAME
   * worktrees — a session's repos are its feature's members — so the pair read as two
   * different capabilities and were one. The stack verbs win because they do strictly
   * more: `/group/start` detects a port conflict with another feature and offers to stop
   * and switch, where the session route just 409s. The ServerBar kept a duplicate pair
   * (`Run all` / `Stop all`) for a while; it is a readout now and these are the only
   * server verbs on screen.
   *
   * THREE selection kinds, one bar: a session, a sessionless feature, and a dev server
   * running from a repo's main checkout. The last used to carry its own buttons inside
   * its rail card — the only buttons in the rail — because it could not be selected.
   */
  import RunConfigMenu from '$lib/components/RunConfigMenu.svelte';
  import OverflowMenu from '$lib/components/OverflowMenu.svelte';
  import { ui, liveMembers } from '$lib/stores/ui.svelte.js';
  // openApp stays for the MAIN-CHECKOUT server, which has no chip to click.
  import { openApp } from '$lib/stores/world.svelte.js';
  import { orphans } from '$lib/stores/orphans.svelte.js';
  import {
    activateSession, addRepoToSession, closeFeature, closeSession, deactivateSession,
    deleteFeature, editFeature, editSession, installDeps, openGroup, openSessionRepos,
    pending, prFeature, promote, reinstateOrphan, restartStack, restartTerminal, runStack,
    startFeatureSession, stopMainServer, stopStack,
  } from '$lib/ops.svelte.js';

  const session = $derived(ui.selected);
  const feature = $derived(ui.selectedFeature);
  /*
   * A resumable conversation among this feature's worktrees.
   *
   * Refreshed when the selection changes rather than on a timer: it can only change when
   * a session is closed, and answering it costs a `git branch` per repo.
   */
  const featureOrphan = $derived(
    feature ? orphans.forPaths(liveMembers(feature).map((m) => m.path)) : null,
  );
  $effect(() => {
    if (feature && !orphans.loadedAt) void orphans.refresh();
  });

  /** A dev server running from a repo's main checkout — the third kind of rail row. */
  const mainServer = $derived(ui.selectedMainServer);

  /** The feature a selected SESSION belongs to, so stack verbs work from either side. */
  const sessionFeature = $derived(
    session && session.feature
      ? (ui.visibleFeatures.find((f) => f.name === session.feature) || null)
      : null,
  );
  const target = $derived(feature || sessionFeature);
  const ms = $derived(target ? liveMembers(target) : []);
  const anyRunning = $derived(ms.some((m) => m.running));
  const anyStartable = $derived(ms.some((m) => m.canStart && !m.running));
  /** Members that cannot start until their dependencies exist. */
  const needDeps = $derived(ms.filter((m) => m.depsMissing));
  const installingDeps = $derived(ms.some((m) => m.depsInstalling));
  const isPending = $derived(!!target && pending.has(target.name));

  /*
   * EVERY worktree the ▷ Run… menu reads configs from — one per repo of the feature.
   *
   * ONLY FOR A FEATURE WITH NO SESSION. A session's copy moved into the Runs tab, beside
   * the history and output a run produces; a sessionless feature has no such tab, and a
   * run needs only a worktree, so this stays as its way in rather than the capability
   * disappearing with the tab it does not have.
   */
  const runTargets = $derived(ms.map((m) => ({ repo: m.repo, path: m.path })));

  /*
   * No identity block here.
   *
   * The bar used to open with the selection's name, repo and branch — which DockHead
   * already shows for a session, and FeaturePane's own heading shows for a feature. Three
   * readouts of one selection (rail card, dock header, this) stacked down the screen is
   * what made every glance cost a second look. The bar is buttons now: the top says WHAT
   * you are looking at, the bottom DOES something to it.
   */
  let busy = $state(false);
  /** @param {() => Promise<any>} fn */
  async function guard(fn: () => Promise<unknown>) {
    busy = true;
    try { await fn(); } finally { busy = false; }
  }
</script>

<div class="actionbar" class:idle={!session && !feature && !mainServer}>
  {#if !session && !feature && !mainServer}
    <span class="hint">Select a feature, session or server to act on it.</span>
  {:else if mainServer}
    <!-- A main-checkout server has no feature and no session: two verbs, and they used
         to be the only buttons in the rail. -->
    <span class="grow"></span>
    {#if (mainServer.ports || []).length}
      <button class="btn sm" onclick={() => openApp(mainServer.ports[0])}>Open {mainServer.repo} ↗</button>
    {/if}
    <button
      class="btn sm ghost dangertext"
      title="Stop the dev server running in {mainServer.repo}'s main checkout"
      onclick={() => stopMainServer(mainServer)}
    >Stop server</button>
  {:else}
    <!-- The `workspace · <repo> · <repo>` readout that used to sit here is gone: it named
         the same repos DockHead's chips name, a few hundred pixels below them. The ports
         it carried moved onto those chips, where they are a fact about a repo rather than
         a second list of repos. -->

    {#if isPending}
      <button class="btn sm" disabled>working…</button>
    {:else}
      <!-- Stack verbs: identical whether you got here via the feature or its agent. -->
      {#if target}
        <!-- One verb per concept, and colour means STATE not action: the start verb is
             the brand hue like every other action, because green here used to mean both
             "is running" and "start this". -->
        <!--
          A CLUSTER, not three loose buttons.
          Stop and Restart act on the same subject as Run — the dev servers — so they are
          drawn as one segmented control with a label saying what that subject is. The bar
          previously mixed full-text verbs ("Run stack") with bare glyphs (✐, 🗑) at the
          same weight, so nothing indicated which controls belonged together or what any
          of them acted ON.
        -->
        {#if anyRunning || anyStartable}
          <span class="cluster" role="group" aria-label="Dev servers">
            <span class="cluster-label">servers</span>
            {#if anyRunning}
              <button class="btn sm ghost" title="Stop the dev servers" aria-label="Stop dev servers" onclick={() => stopStack(target.name)}>{'■'}</button>
              <button class="btn sm ghost" title="Restart the dev servers" aria-label="Restart dev servers" onclick={() => restartStack(target.name)}>{'↻'}</button>
            {:else if anyStartable}
              <button class="btn sm primary" title="Start the dev servers" aria-label="Start dev servers" onclick={() => runStack(target.name)}>{'▶︎'}</button>
            {/if}
          </span>
        {/if}

        <!-- Offered where the problem is visible, rather than letting Run stack half-fail. -->
        {#if needDeps.length}
          <button
            class="btn sm"
            disabled={installingDeps}
            title="{needDeps.map((m) => m.repo).join(', ')} cannot start until their dependencies are installed"
            onclick={() => needDeps.forEach((m) => installDeps({ repo: m.repo, path: m.path }))}
          >{installingDeps ? 'Installing…' : `Install deps (${needDeps.length})`}</button>
        {/if}
      {/if}

      {#if session}
        <!-- Branch on worktreePath itself rather than a derived boolean: a boolean
             tells the compiler nothing about the field being non-null here. -->
        <!-- Promote is the ONE thing that stays on the bar unclustered: before it there is
             no worktree, so none of the verbs around it apply yet, and it is the only
             thing to do. -->
        {#if !session.worktreePath}
          <button class="btn sm primary" disabled={busy} onclick={() => guard(() => promote(session))}>Promote to worktree</button>
        {/if}
        <!-- Glyphs, like ✐ and 🗑 beside them, with the name in `aria-label` and the
             tooltip — an icon with no accessible name is a different bug.
             Play/pause rather than the ▷ this app already spends on "Run a config":
             one glyph for two actions is the trap the PR/MR note above describes. The
             pair is honest here anyway — deactivate IS pause: the process stops, the
             session and its conversation stay. U+FE0E keeps them as text glyphs; both
             have emoji presentations that would arrive full-colour and oversized. -->
        <!--
          The AGENT's own cluster, mirroring the servers one above: same shape, same
          glyphs for the same meanings (▶ start, ■ stop, ↻ restart), a label saying what
          it acts on. Two clusters that look alike and read differently by their label is
          the whole point — previously ▶ meant "resume the agent" while "Run stack" meant
          the servers, in two completely different visual forms.
        -->
        <span class="cluster" role="group" aria-label="Agent">
          <span class="cluster-label">agent</span>
          {#if session.active === false}
            <button
              class="btn sm primary"
              title="Resume — restart the agent and reattach its conversation"
              aria-label="Resume agent"
              disabled={busy}
              onclick={() => guard(() => activateSession(session))}
            >{'▶︎'}</button>
          {:else}
            <button
              class="btn sm ghost"
              title="Pause — stop the process but keep the session and its conversation"
              aria-label="Pause agent"
              disabled={busy}
              onclick={() => guard(() => deactivateSession(session))}
            >{'⏸︎'}</button>
            <!-- Restarts the TERMINAL, not the agent: for a pane that has stopped
                 redrawing or come back the wrong size. Distinct from ↻ in the servers
                 cluster, which is why each carries its own label and tooltip. -->
            <button
              class="btn sm ghost"
              title="Restart the terminal — keeps the agent and its conversation"
              aria-label="Restart terminal"
              disabled={busy}
              onclick={() => guard(() => restartTerminal(session))}
            >{'↺'}</button>
          {/if}
        </span>
        <!--
          THE SPLIT, and the rule the whole bar is arranged by: left of this divider is
          everything reversible and pressed constantly; right of it is what changes what
          the feature IS. Losing a dev server costs seconds; losing a session costs a
          conversation, so they do not belong at the same weight in the same row.

          Open in editor moved in here at the owner's request — used rarely enough not to
          earn permanent width.
        -->
        <span class="split" aria-hidden="true"></span>
        {@const sess = session}
        <OverflowMenu>
          {#snippet children(pick)}
            {#if sess.worktreePath}
              <!-- Opens EVERY repo the session spans. It used to pass session.worktreePath
                   — the primary alone — so a BE+FE feature opened half of itself. -->
              <button role="menuitem" onclick={() => pick(() => openSessionRepos(sess))}>
                <span class="g">↗</span> Open in editor{sess.repos.length > 1 ? ` (${sess.repos.length})` : ''}
              </button>
            {/if}
            <button role="menuitem" onclick={() => pick(() => addRepoToSession(sess))}>
              <span class="g">＋</span> Add a repo
            </button>
            <button role="menuitem" onclick={() => pick(() => editSession(sess))}>
              <span class="g">✐</span> Edit name, colour, links
            </button>
            {#if target}
              <button role="menuitem" onclick={() => pick(() => prFeature(target.name))}>
                <span class="g">⑂</span> Create PR / MR
              </button>
            {/if}
            <span class="sep"></span>
            <button role="menuitem" class="danger" onclick={() => pick(() => closeSession(sess))}>
              <span class="g">🗑</span> Delete session
            </button>
          {/snippet}
        </OverflowMenu>
      {:else if feature}
        <!--
          A feature with a CONVERSATION on disk offers to resume it, not to start fresh.
          Closing a session deletes Studio's pointer; the transcript belongs to Claude Code
          and stays. Starting a blank agent in a directory full of half-finished work is
          almost never what you want, so the verb changes rather than sitting beside it.
        -->
        {#if featureOrphan}
          <button
            class="btn sm primary"
            title="Resume the agent that was working here — its conversation is still on disk"
            onclick={() => reinstateOrphan(featureOrphan)}
          >Resume previous agent</button>
          <button class="btn sm ghost" title="Start a fresh agent instead" onclick={() => startFeatureSession(feature)}>Start fresh</button>
        {:else}
          <button class="btn sm primary" onclick={() => startFeatureSession(feature)}>Start session</button>
        {/if}
        <!-- The one mount of this outside the Runs tab — see runTargets above. -->
        {#if runTargets.length}
          <RunConfigMenu targets={runTargets} />
        {/if}
        <button class="btn sm" onclick={() => openGroup(feature.name)}>Open in editor</button>
        <!-- "Open PR / MR" said CREATE here and OPEN IN BROWSER on the CI pill — the same four
             words for two different actions. This one creates. -->
        <button class="btn sm" onclick={() => prFeature(feature.name)}>Create PR / MR</button>
        <button class="btn sm ghost" title="Colour this feature" aria-label="Edit feature" onclick={() => editFeature(feature)}>✐</button>
        {#if anyRunning}
          <button class="btn sm ghost" onclick={() => closeFeature(feature.name)}>Close feature</button>
        {/if}
        <button class="btn sm ghost dangertext" onclick={() => deleteFeature(feature)}>Delete feature…</button>
      {/if}
    {/if}
  {/if}
</div>

<style>
  /* A GROUP inside the dock's bar, not a band of its own: no padding, no border, no
     background and no min-height, all of which belong to whatever row hosts it. Owning
     them here is what made this a second horizontal band at the foot of the window. */
  .actionbar {
    display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
    flex: none; min-width: 0;
  }

  /*
   * A cluster is several verbs acting on ONE subject, drawn as one control.
   *
   * The bar mixed full-text verbs ("Run stack", "Open in editor") with bare glyphs
   * (✐, 🗑) at identical weight, so nothing said which buttons belonged together or what
   * any of them acted on — twelve equal things in a row. Grouping is what makes ▶ mean
   * "start the servers" in one cluster and "resume the agent" in the next without either
   * needing to spell it out.
   */
  .cluster {
    display: inline-flex; align-items: center; gap: 2px;
    border: 1px solid var(--border); border-radius: 8px; padding: 2px 3px 2px 0;
    background: var(--bg);
  }
  .cluster :global(.btn) { border-color: transparent; background: transparent; }
  .cluster :global(.btn:hover) { border-color: var(--border-strong); }
  /* The primary sits inside a cluster, so it keeps its fill but not a second border. */
  .cluster :global(.btn.primary) { background: var(--brand); color: var(--brand-ink); }
  /* Lowercase and quiet: it names the SUBJECT, and a label competing with the verbs it
     labels would defeat the grouping it exists to explain. */
  .cluster-label {
    font-family: var(--mono); font-size: 10px; letter-spacing: .08em;
    color: var(--faint); padding: 0 2px 0 8px; user-select: none;
  }

  /* Before the destructive verb, which belongs to no cluster and should not look like it
     does. A rule rather than a gap: a gap alone reads as accidental. */
  .sep { width: 1px; align-self: stretch; margin: 2px 4px; background: var(--border); }
  /* Present even when empty, so selecting something never shifts the layout. */
  .actionbar.idle { color: var(--faint); }
  .hint { font-family: var(--mono); font-size: 10.5px; color: var(--faint); }

  .grow { flex: 1; }
  /* --del: the literal was a fourth red, and failed AA at 3.91:1. */
  .dangertext { color: var(--del); }
</style>
