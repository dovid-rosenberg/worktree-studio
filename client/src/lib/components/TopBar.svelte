<script lang="ts">
  /*
   * The application header: brand, multiplexer badge, the fleet-wide summary, the
   * Overview toggle (carrying the waiting-count attention badge), and global actions.
   *
   * The summary counts and the stack-wide buttons used to live in Fleet's own summary
   * bar, which meant they were only visible while Fleet was. They belong here: they
   * describe the whole fleet, not one view of it, and the numbers are the reason you
   * would open Overview in the first place.
   *
   * The `actions` snippet is kept from the foundation version so a caller can inject
   * extra controls without this component learning about them.
   */
  import { theme, toggleTheme } from '$lib/theme.svelte.js';
  import { world } from '$lib/stores/world.svelte.js';
  import { ui, featureActive, liveMembers } from '$lib/stores/ui.svelte.js';
  import { overlays } from '$lib/stores/overlays.svelte.js';
  import { notify } from '$lib/stores/notify.svelte.js';
  import { restartStack, stopStack } from '$lib/ops.svelte.js';

  let { actions = undefined } = $props();

  const feats = $derived(world.features);
  const flat = $derived(feats.flatMap((f) => liveMembers(f)));
  const running = $derived(flat.filter((m) => m.running).length);
  const working = $derived(flat.filter((m) => m.session && m.session.state === 'working').length);
  const waiting = $derived(flat.filter((m) => m.session && m.session.state === 'waiting').length);
  const unpromoted = $derived(world.sessions.filter((s) => !s.worktreePath).length);

  const runningFeats = () => feats.filter((f) => liveMembers(f).some((m) => m.running));
  const anyRunning = $derived(feats.some(featureActive));
</script>

<header class="topbar">
  <div class="brand"><span class="glyph">⎇</span> Worktree&nbsp;Studio</div>
  <!-- data-n drives the ::after badge; 0 hides it (see the .attn rules). The waiting
       count rides on Insights now that Overview is gone — it is the only app-level view
       left, so it is where an attention badge can live without inventing a home. -->
  <button
    class="btn ghost ovbtn attn"
    class:on={ui.dockView === 'usage'}
    aria-pressed={ui.dockView === 'usage'}
    data-n={notify.waitingCount}
    title={notify.waitingCount ? `${notify.waitingCount} session(s) waiting for you` : 'Insights (⌘\\)'}
    onclick={() => ui.toggleUsage()}
  >◔ Insights</button>

  <div class="counts" aria-label="Fleet summary">
    <span class="c"><b>{feats.length}</b> features</span>
    {#if unpromoted}<span class="c"><span class="pi">✦</span><b>{unpromoted}</b> unpromoted</span>{/if}
    <span class="c"><span class="dot done"></span><b>{running}</b> running</span>
    <span class="c"><span class="dot working"></span><b>{working}</b> working</span>
    <span class="c"><span class="dot waiting"></span><b>{waiting}</b> waiting</span>
  </div>

  {#if anyRunning}
    <button class="btn ghost sm" onclick={() => runningFeats().forEach((f) => restartStack(f.name))}>Restart all</button>
    <button class="btn ghost sm" onclick={() => runningFeats().forEach((f) => stopStack(f.name))}>Stop all</button>
  {/if}

  <span class="spacer"></span>
  {@render actions?.()}

  <button class="btn ghost" title="Command palette (⌘K)" aria-label="Command palette" onclick={() => overlays.togglePalette()}>⌘K</button>
  <button class="btn ghost" title="Connections & settings" aria-label="Connections & settings" onclick={() => overlays.openSettings()}>⚙</button>
  <button
    class="btn ghost"
    onclick={toggleTheme}
    title="Toggle theme"
    aria-label="Toggle theme"
    aria-pressed={theme.current === 'light'}
  >◐</button>
  <button class="btn primary" onclick={() => overlays.openIntake()}>+ New session</button>
</header>

<style>
  .topbar { display:flex; align-items:center; gap:12px; row-gap:8px; flex-wrap:wrap; padding:10px 16px; border-bottom:1px solid var(--border); background:var(--panel); flex:none; }
  .brand { font-weight:700; font-size:15px; letter-spacing:-.01em; display:flex; align-items:center; gap:7px; }
  .brand .glyph { color:var(--brand); font-size:17px; }

  .ovbtn { font-weight:600; }
  .ovbtn.on { background:var(--brand); border-color:var(--brand); color:var(--brand-ink); }

  .counts { display:flex; align-items:center; gap:7px; flex-wrap:wrap; font-family:var(--mono); font-size:10.5px; color:var(--muted); }
  .counts .c { display:inline-flex; align-items:center; gap:5px; border:1px solid var(--border); border-radius:20px; padding:2px 9px; background:var(--elevated); }
  .counts .c b { color:var(--ink); font-variant-numeric:tabular-nums; }
  .counts .pi { font-size:9px; font-style:normal; }

  /* Attention badge: the number of sessions currently waiting. */
  .attn { position:relative; }
  .attn::after { content:attr(data-n); position:absolute; top:-6px; right:-6px; min-width:16px; height:16px; padding:0 4px; background:var(--waiting); color:#241a06; font-family:var(--mono); font-size:10px; font-weight:700; border-radius:999px; display:grid; place-items:center; box-shadow:0 0 0 2px var(--panel); }
  .attn[data-n="0"]::after, .attn:not([data-n])::after { display:none; }
</style>
