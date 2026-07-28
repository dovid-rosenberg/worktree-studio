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
   */
  import { ui, liveMembers } from '$lib/stores/ui.svelte.js';
  import { openApp, webAppsFor } from '$lib/stores/world.svelte.js';
  import {
    activateSession, addRepoToSession, closeFeature, closeSession, deactivateSession,
    deleteFeature, openEditor, openGroup, pending, prFeature, promote, renameSession,
    restartStack, runStack, startFeatureSession, startSessionServers, stopSessionServers,
    stopStack,
  } from '$lib/ops.svelte.js';

  const session = $derived(ui.selected);
  const feature = $derived(ui.selectedFeature);

  /** The feature a selected SESSION belongs to, so stack verbs work from either side. */
  const sessionFeature = $derived(
    session && session.feature
      ? (ui.visibleFeatures.find((f: any) => f.name === session.feature) || null)
      : null,
  );
  const target = $derived(feature || sessionFeature);
  const ms = $derived(target ? liveMembers(target) : []);
  const anyRunning = $derived(ms.some((m: any) => m.running));
  const anyStartable = $derived(ms.some((m: any) => m.canStart && !m.running));
  const webApps = $derived(webAppsFor(ms));
  const isPending = $derived(!!target && pending.has(target.name));

  const label = $derived(session ? session.title : (feature ? feature.name : ''));
  const sub = $derived(
    session
      ? `${session.repoName}${session.branch ? ` · ${session.branch}` : ''}`
      : (feature ? `${ms.length} repo${ms.length === 1 ? '' : 's'} · no agent` : ''),
  );

  let busy = $state(false);
  /** @param {() => Promise<any>} fn */
  async function guard(fn: any) {
    busy = true;
    try { await fn(); } finally { busy = false; }
  }
</script>

<div class="actionbar" class:idle={!session && !feature}>
  {#if !session && !feature}
    <span class="hint">Select a feature or agent to act on it.</span>
  {:else}
    <span class="who">
      <span class="dot {session ? session.state : (anyRunning ? 'done' : 'idle')}"></span>
      <span class="nm">{label}</span>
      <span class="sb">{sub}</span>
    </span>

    <span class="grow"></span>

    {#if isPending}
      <button class="btn sm" disabled>working…</button>
    {:else}
      <!-- Stack verbs: identical whether you got here via the feature or its agent. -->
      {#if target}
        {#if anyRunning}
          <button class="btn sm danger" onclick={() => stopStack(target.name)}>Stop stack</button>
          <button class="btn sm" onclick={() => restartStack(target.name)}>Restart</button>
        {:else if anyStartable}
          <button class="btn sm go" onclick={() => runStack(target.name)}>Run stack</button>
        {/if}
        {#each webApps as web (web.repo)}
          <button class="btn sm" onclick={() => openApp(web.port)}>Open {web.repo} ↗</button>
        {/each}
      {/if}

      {#if session}
        <!-- Branch on worktreePath itself rather than a derived boolean: a boolean
             tells the compiler nothing about the field being non-null here. -->
        {#if session.worktreePath}
          <!-- Bound to a const: the narrowing inside the block does not survive into an
               arrow function, since `session` could be reassigned before it runs. -->
          {@const wt = session.worktreePath}
          <button class="btn sm" onclick={() => openEditor(wt)}>Open in editor</button>
          <button class="btn sm" onclick={() => startSessionServers(session)}>Run servers</button>
          <button class="btn sm ghost" onclick={() => stopSessionServers(session)}>Stop servers</button>
        {:else}
          <button class="btn sm primary" disabled={busy} onclick={() => guard(() => promote(session))}>⤴ Promote to worktree</button>
        {/if}
        <button class="btn sm" title="Add another repo to this feature" onclick={() => addRepoToSession(session)}>＋ repo</button>
        <button class="btn sm ghost" title="Rename" aria-label="Rename session" onclick={() => renameSession(session)}>✐</button>
        {#if session.active === false}
          <button class="btn sm go" disabled={busy} onclick={() => guard(() => activateSession(session))}>↻ Resume</button>
        {:else}
          <button
            class="btn sm ghost"
            title="Stop the process but keep the session (resumable)"
            disabled={busy}
            onclick={() => guard(() => deactivateSession(session))}
          >Deactivate</button>
        {/if}
        <button class="btn sm ghost dangertext" aria-label="Delete session" title="Delete session" onclick={() => closeSession(session)}>🗑</button>
      {:else if feature}
        <button class="btn sm primary" onclick={() => startFeatureSession(feature)}>Start session here</button>
        <button class="btn sm" onclick={() => openGroup(feature.name)}>Open in editor</button>
        <button class="btn sm" onclick={() => prFeature(feature.name)}>Open PR / MR</button>
        {#if anyRunning}
          <button class="btn sm ghost" onclick={() => closeFeature(feature.name)}>Close feature</button>
        {/if}
        <button class="btn sm ghost dangertext" onclick={() => deleteFeature(feature)}>Delete feature…</button>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .actionbar {
    display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
    padding: 8px 14px; border-top: 1px solid var(--border); background: var(--panel);
    flex: none; min-height: 45px;
  }
  /* Present even when empty, so selecting something never shifts the layout. */
  .actionbar.idle { color: var(--faint); }
  .hint { font-family: var(--mono); font-size: 10.5px; color: var(--faint); }

  .who { display: inline-flex; align-items: center; gap: 8px; min-width: 0; max-width: 46%; }
  .who .nm { font-weight: 620; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .who .sb { font-family: var(--mono); font-size: 10.5px; color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .grow { flex: 1; }
  .dangertext { color: #e5484d; }
</style>
