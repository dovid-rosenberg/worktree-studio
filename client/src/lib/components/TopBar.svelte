<script lang="ts">
  /*
   * The application header: brand, the Insights toggle (carrying the waiting-count
   * attention badge), the fleet-wide summary, and global actions.
   *
   * TWO VOCABULARIES, SAID SEPARATELY. `running` counts dev SERVERS; `working` and
   * `waiting` count AGENTS. Printed as one comma-run they read as parts of one total
   * and did not add up — `7 features · 1 running · 4 working · 0 waiting` invites the
   * arithmetic and then fails it. They are two groups now, each labelled by what it
   * counts.
   *
   * AND THEY WERE COUNTED PER MEMBER, NOT PER AGENT. `flat` is every member worktree
   * across every feature, so a 3-repo feature with one working agent contributed THREE
   * to `working` — the numbers were inflated by exactly how multi-repo your work is.
   * Agent states count distinct sessions now; only the server count is per worktree,
   * which is correct because each worktree runs its own.
   *
   * Zeros are hidden: a count of zero takes the same space as a real one and says
   * nothing.
   */
  import { theme, toggleTheme } from '$lib/theme.svelte.js';
  import { world } from '$lib/stores/world.svelte.js';
  import { ui, featureActive, liveMembers } from '$lib/stores/ui.svelte.js';
  import { overlays } from '$lib/stores/overlays.svelte.js';
  import { notify } from '$lib/stores/notify.svelte.js';
  import { restartStack, stopStack } from '$lib/ops.svelte.js';

  const feats = $derived(world.features);
  /** Per WORKTREE: each one runs its own dev server, so this is the honest denominator. */
  const running = $derived(feats.flatMap((f) => liveMembers(f)).filter((m) => m.running).length);
  /** Per AGENT: one session drives a whole feature, however many repos it spans. */
  const working = $derived(world.sessions.filter((s) => s.state === 'working').length);
  const waiting = $derived(world.sessions.filter((s) => s.state === 'waiting').length);
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

    {#if working || waiting}
      <span class="grp" aria-label="Agents">
        <span class="lbl">agents</span>
        {#if working}<span class="c"><span class="dot working"></span><b>{working}</b> working</span>{/if}
        {#if waiting}<span class="c"><span class="dot waiting"></span><b>{waiting}</b> waiting</span>{/if}
      </span>
    {/if}

    {#if running}
      <span class="grp" aria-label="Dev servers">
        <span class="lbl">servers</span>
        <span class="c"><span class="dot done"></span><b>{running}</b> up</span>
      </span>
    {/if}
  </div>

  {#if anyRunning}
    <button class="btn ghost sm" onclick={() => runningFeats().forEach((f) => restartStack(f.name))}>Restart all</button>
    <button class="btn ghost sm" onclick={() => runningFeats().forEach((f) => stopStack(f.name))}>Stop all</button>
  {/if}

  <span class="spacer"></span>

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
  /* Each group names what it counts, so the two never read as one total. */
  .counts .grp { display:inline-flex; align-items:center; gap:6px; padding-left:9px; border-left:1px solid var(--border); }
  .counts .lbl { font-size:9px; letter-spacing:.09em; text-transform:uppercase; color:var(--faint); }

  /* Attention badge: the number of sessions currently waiting. */
  .attn { position:relative; }
  .attn::after { content:attr(data-n); position:absolute; top:-6px; right:-6px; min-width:16px; height:16px; padding:0 4px; background:var(--waiting); color:#241a06; font-family:var(--mono); font-size:10px; font-weight:700; border-radius:999px; display:grid; place-items:center; box-shadow:0 0 0 2px var(--panel); }
  .attn[data-n="0"]::after, .attn:not([data-n])::after { display:none; }
</style>
