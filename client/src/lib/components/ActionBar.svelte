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
  import { ui, liveMembers } from '$lib/stores/ui.svelte.js';
  import { openApp, webAppsFor } from '$lib/stores/world.svelte.js';
  import {
    activateSession, addRepoToSession, closeFeature, closeSession, deactivateSession,
    deleteFeature, editFeature, editSession, installDeps, openGroup, openSessionRepos,
    pending, prFeature, promote, restartStack, restartTerminal, runStack, startFeatureSession,
    stopMainServer, stopStack,
  } from '$lib/ops.svelte.js';

  const session = $derived(ui.selected);
  const feature = $derived(ui.selectedFeature);
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
  const webApps = $derived(webAppsFor(ms));
  const isPending = $derived(!!target && pending.has(target.name));

  /*
   * EVERY worktree the ▷ Run menu reads configs from — one per repo of the feature.
   *
   * Not just the session's own: a feature is several repos, so a menu showing one of them
   * can only reach half the work. On a BE+FE feature you want both sets of tests.
   *
   * Falls back to the session's own worktree when there is no resolved feature (a
   * promoted session whose feature has not landed in the topology yet).
   */
  const runTargets = $derived.by(() => {
    const fromFeature = ms.map((m) => ({ repo: m.repo, path: m.path }));
    if (fromFeature.length) return fromFeature;
    return session?.worktreePath ? [{ repo: session.repoName, path: session.worktreePath }] : [];
  });

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
        {#if anyRunning}
          <button class="btn sm danger" onclick={() => stopStack(target.name)}>Stop stack</button>
          <button class="btn sm" onclick={() => restartStack(target.name)}>Restart stack</button>
        {:else if anyStartable}
          <button class="btn sm primary" onclick={() => runStack(target.name)}>Run stack</button>
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
        {#each webApps as web (web.repo)}
          <button class="btn sm" onclick={() => openApp(web.port)}>Open {web.repo} ↗</button>
        {/each}
        {#if runTargets.length}
          <RunConfigMenu targets={runTargets} sessionId={session?.id ?? null} />
        {/if}
      {/if}

      {#if session}
        <!-- Branch on worktreePath itself rather than a derived boolean: a boolean
             tells the compiler nothing about the field being non-null here. -->
        {#if session.worktreePath}
          <!-- Bound to a const: the narrowing inside the block does not survive into an
               arrow function, since `session` could be reassigned before it runs. -->
          {@const sess = session}
          <!-- Opens EVERY repo the session spans. It used to pass session.worktreePath —
               the primary alone — so a BE+FE feature opened half of itself. -->
          <button
            class="btn sm"
            title={sess.repos.length > 1 ? `Open all ${sess.repos.length} repos in the editor` : 'Open in editor'}
            onclick={() => openSessionRepos(sess)}
          >Open in editor{sess.repos.length > 1 ? ` (${sess.repos.length})` : ''}</button>
        {:else}
          <button class="btn sm primary" disabled={busy} onclick={() => guard(() => promote(session))}>Promote to worktree</button>
        {/if}
        <button class="btn sm" title="Add another repo to this feature" onclick={() => addRepoToSession(session)}>＋ repo</button>
        <button class="btn sm ghost" title="Edit name and colour" aria-label="Edit session" onclick={() => editSession(session)}>✐</button>
        <!-- Glyphs, like ✐ and 🗑 beside them, with the name in `aria-label` and the
             tooltip — an icon with no accessible name is a different bug.
             Play/pause rather than the ▷ this app already spends on "Run a config":
             one glyph for two actions is the trap the PR/MR note above describes. The
             pair is honest here anyway — deactivate IS pause: the process stops, the
             session and its conversation stay. U+FE0E keeps them as text glyphs; both
             have emoji presentations that would arrive full-colour and oversized. -->
        {#if session.active === false}
          <button
            class="btn sm primary"
            title="Resume — restart the agent and reattach its conversation"
            aria-label="Resume session"
            disabled={busy}
            onclick={() => guard(() => activateSession(session))}
          >{'▶︎'}</button>
        {:else}
          <!-- Restart the TERMINAL, not the agent: for a pane that has stopped redrawing
               or come back the wrong size after a display change. Beside pause because
               they are the same kind of thing — a state you get out of — and distinct
               from Delete, which ends the work. -->
          <button
            class="btn sm ghost"
            title="Restart the terminal — keeps the agent and its conversation"
            aria-label="Restart terminal"
            disabled={busy}
            onclick={() => guard(() => restartTerminal(session))}
          >{'↺'}</button>
          <button
            class="btn sm ghost"
            title="Deactivate — stop the process but keep the session (resumable)"
            aria-label="Deactivate session"
            disabled={busy}
            onclick={() => guard(() => deactivateSession(session))}
          >{'⏸︎'}</button>
        {/if}
        <button class="btn sm ghost dangertext" aria-label="Delete session" title="Delete session" onclick={() => closeSession(session)}>🗑</button>
      {:else if feature}
        <button class="btn sm primary" onclick={() => startFeatureSession(feature)}>Start session</button>
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
  /* Present even when empty, so selecting something never shifts the layout. */
  .actionbar.idle { color: var(--faint); }
  .hint { font-family: var(--mono); font-size: 10.5px; color: var(--faint); }

  .grow { flex: 1; }
  /* --del: the literal was a fourth red, and failed AA at 3.91:1. */
  .dangertext { color: var(--del); }
</style>
