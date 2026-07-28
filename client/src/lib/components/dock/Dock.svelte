<script>
  /*
   * The dock: header, tab strip, the live terminal (plus its split), the DOM panels,
   * and the server bar.
   *
   * Structural rule, carried straight over from app.js: switching to Changes/Logs/
   * Insights HIDES the terminal area, it does not unmount it. A tmux pane is cheap to
   * hide and expensive to reattach — unmounting would drop the socket, reset the
   * buffer, and make every tab switch cost a redraw. `active` tells the Terminal it is
   * hidden so it stops fitting against a 0×0 box.
   */
  import Terminal from '$lib/components/Terminal.svelte';
  import DockHead from '$lib/components/dock/DockHead.svelte';
  import TabStrip from '$lib/components/dock/TabStrip.svelte';
  import ServerBar from '$lib/components/dock/ServerBar.svelte';
  import SplitPane from '$lib/components/dock/SplitPane.svelte';
  import LogsPanel from '$lib/components/dock/LogsPanel.svelte';
  import ReviewMount from '$lib/components/dock/ReviewMount.svelte';
  import InsightsMount from '$lib/components/dock/InsightsMount.svelte';
  import { api } from '$lib/api.js';
  import { ui } from '$lib/stores/ui.svelte.js';
  import { world } from '$lib/stores/world.svelte.js';
  import { overlays } from '$lib/stores/overlays.svelte.js';

  const session = $derived(ui.selected);
  const isTerm = $derived(ui.dockView === 'term');
  const splitOn = $derived(!!session && ui.splitOn(session.id));

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
        const data = await api('GET', `/api/sessions/${id}/commits`);
        if (!alive) return;
        changesCount = (data.repos || []).reduce(
          (/** @type {number} */ n, /** @type {any} */ r) => n + ((r.uncommitted && r.uncommitted.fileCount) || 0),
          0,
        );
      } catch { /* a git failure must not take the tab strip with it */ }
    }, 400);
    return () => { alive = false; clearTimeout(t); };
  });
</script>

<section class="dock">
  {#if !session}
    <div class="empty">
      <div class="empty-glyph">⎇</div>
      <h2>No session selected</h2>
      <p>
        Start one from any source — free text, a GitHub / GitLab issue, or an Asana task. It boots a
        real Claude&nbsp;Code session on your CLAUDE.md, and you promote it to a worktree when
        it&rsquo;s real work.
      </p>
      <button class="btn primary" onclick={() => overlays.openIntake()}>+ New session</button>
    </div>
  {:else}
    <DockHead {session} />
    <TabStrip {session} {changesCount} />

    <!-- Hidden, never unmounted: see the note at the top of this file. -->
    <div class="term-area" class:term-split={splitOn} hidden={!isTerm}>
      <Terminal {sessionId} active={isTerm} />
      {#if splitOn}
        <SplitPane {sessionId} />
      {/if}
    </div>

    {#if ui.dockView === 'changes'}
      <ReviewMount {session} onchangescount={(/** @type {number} */ n) => (changesCount = n)} />
    {:else if ui.dockView === 'logs'}
      <LogsPanel {session} />
    {:else if ui.dockView === 'insights'}
      <InsightsMount {session} />
    {/if}

    <ServerBar {session} />
  {/if}
</section>

<style>
  .dock { display:flex; flex-direction:column; min-height:0; min-width:0; }
  .empty { margin:auto; text-align:center; max-width:440px; padding:40px; color:var(--muted); }
  .empty-glyph { font-size:40px; color:var(--border-strong); }
  .empty h2 { margin:12px 0 6px; color:var(--ink); font-size:20px; }
  .empty p { font-size:14px; line-height:1.55; }
  .empty .btn { margin-top:16px; }

  .term-area { flex:1; min-height:0; min-width:0; display:flex; flex-direction:column; }
  /* The 2px gap showing --border is the divider; no extra element to keep aligned. */
  .term-area.term-split { display:grid; grid-template-columns:1fr 1fr; gap:2px; background:var(--border); }
  .term-area.term-split > :global(.term-wrap) { min-width:0; }
</style>
