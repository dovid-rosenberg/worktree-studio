<script lang="ts">
  /*
   * The ▷ Run menu: this worktree's editor run configurations.
   *
   * FETCHED ON OPEN, not carried in the topology payload. The payload is broadcast on
   * every git rescan, and putting a per-worktree directory scan on that path would cost a
   * handful of stats per worktree per broadcast for a list that is only read when this
   * menu is open. It is also why the list is always current: it is read at the moment you
   * ask for it.
   *
   * Two kinds, and the difference is visible because it decides where the thing goes:
   *   ▸ server — tracked like a dev server. Ports, logs, and Stop stack reaches it.
   *   ⌗ task   — a terminal tab you watch. Needs a session, since a tab needs a tmux
   *              session to live in.
   */
  import { api } from '$lib/api.js';
  import { ui } from '$lib/stores/ui.svelte.js';
  import { toast } from '$lib/stores/toasts.svelte.js';
  import { errMessage } from '$lib/errmsg.js';

  /** One repo of the feature: which repo, and the worktree to read its configs from. */
  export interface Target { repo: string; path: string }

  let { targets, sessionId = null }: {
    targets: Target[];
    sessionId?: string | null;
  } = $props();

  interface Cfg { name: string; cmd: string; kind: string; source: string; file?: string }
  interface Group { repo: string; path: string; configs: Cfg[] }

  let open = $state(false);
  let loading = $state(false);
  let error = $state('');
  let groups = $state<Group[]>([]);
  let root = $state<HTMLElement | null>(null);
  let running = $state('');

  const total = $derived(groups.reduce((n, g) => n + g.configs.length, 0));

  /**
   * Read every repo of the feature, concurrently.
   *
   * One repo's configs is half a BE+FE feature. A repo whose read fails contributes an
   * empty group rather than failing the menu — one unreadable worktree should not hide
   * the others' configs.
   */
  async function load() {
    loading = true;
    error = '';
    try {
      groups = await Promise.all(
        targets.map(async (t) => {
          const q = `?repo=${encodeURIComponent(t.repo)}&worktreePath=${encodeURIComponent(t.path)}`;
          try {
            const r = await api('GET', `/api/v1/run-configs${q}`);
            return { repo: t.repo, path: t.path, configs: (r.configs || []) as Cfg[] };
          } catch {
            return { repo: t.repo, path: t.path, configs: [] as Cfg[] };
          }
        }),
      );
    } catch (e) {
      error = errMessage(e);
    } finally {
      loading = false;
    }
  }

  function toggle() {
    open = !open;
    // Re-read every time it opens: the file on disk is the truth, and you may have just
    // edited it in your editor.
    if (open) load();
  }

  async function run(g: Group, c: Cfg) {
    running = `${g.repo}:${c.name}`;
    try {
      const r = await api('POST', '/api/v1/run-configs/run', {
        repo: g.repo, worktreePath: g.path, name: c.name, sessionId,
      });
      if (!r.ok) {
        toast(r.error || `Could not run “${c.name}”`, true);
      } else if (c.kind === 'server') {
        // A server's outcome is its ports and its log, neither of which is in Runs.
        toast(`Started “${c.name}”`);
      } else {
        /*
         * Go to where the output is. You clicked run to watch something happen, and
         * leaving you on the terminal means the one thing you asked for is the one thing
         * you cannot see — the panel is where the status, the duration and the output are.
         */
        ui.setDockView('runs');
      }
    } catch (e) {
      toast(errMessage(e), true);
    } finally {
      running = '';
      open = false;
    }
  }

  // Bound only while open — a permanent document listener for a menu that is almost
  // always shut is a cost paid on every click in the app.
  $effect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (root && e.target instanceof Node && !root.contains(e.target)) open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      // Stop it reaching the global handler, which reads a bare Escape as "interrupt the
      // agent" and sends it to the pty.
      if (e.key === 'Escape') { e.stopPropagation(); open = false; }
    };
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onKey, true);
    };
  });
</script>

<div class="runmenu" bind:this={root}>
  <button
    class="btn sm"
    aria-haspopup="menu"
    aria-expanded={open}
    title="Run a configuration from this worktree's editor configs"
    onclick={toggle}
  >▷ Run</button>

  {#if open}
    <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
    <div class="sheet" role="menu" tabindex="-1">
      {#if loading}
        <div class="note">Reading this worktree's configs…</div>
      {:else if error}
        <div class="note err">{error}</div>
      {:else if !total}
        <div class="note">
          No run configurations in {targets.length === 1 ? 'this worktree' : 'these worktrees'}.
          Studio reads <code>.idea/runConfigurations</code>, <code>.vscode</code> and
          <code>.zed</code> from each one.
        </div>
      {:else}
        {#each groups.filter((g) => g.configs.length) as g (g.repo)}
          <!-- Headed by repo whenever the feature spans more than one, so two repos with a
               "test:unit" each are told apart. -->
          {#if groups.filter((x) => x.configs.length).length > 1}
            <div class="grp">{g.repo}</div>
          {/if}
          {#each g.configs as c (c.name)}
            <button
              role="menuitem"
              disabled={!!running}
              title={`${c.cmd}${c.file ? `\n\nfrom ${c.file}` : ''}`}
              onclick={() => run(g, c)}
            >
              <span class="g" class:server={c.kind === 'server'}>{c.kind === 'server' ? '▸' : '⌗'}</span>
              <span class="nm">{running === `${g.repo}:${c.name}` ? `${c.name} …` : c.name}</span>
              <span class="src">{c.source}</span>
            </button>
          {/each}
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .runmenu { position: relative; display: inline-flex; }

  .sheet {
    position: absolute; bottom: calc(100% + 6px); right: 0; z-index: 60;
    min-width: 260px; max-width: 420px; padding: 5px;
    background: var(--panel); border: 1px solid var(--border-strong);
    border-radius: 10px; box-shadow: var(--shadow);
    display: flex; flex-direction: column; max-height: 60vh; overflow-y: auto;
  }
  .sheet button {
    display: flex; align-items: center; gap: 9px;
    padding: 7px 9px; border: 0; border-radius: 7px;
    background: none; color: var(--ink); font: inherit; font-size: 13px;
    text-align: left; cursor: pointer;
  }
  .sheet button:hover:not(:disabled) { background: var(--elevated); }
  .sheet button:disabled { opacity: .55; cursor: default; }
  /* Fixed gutter so the names line up whatever the glyph. */
  .sheet .g { flex: none; width: 14px; text-align: center; color: var(--faint); font-size: 12px; }
  .sheet .g.server { color: var(--done); }
  .sheet .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sheet .src { flex: none; font-family: var(--mono); font-size: 10px; color: var(--faint); }
  .grp { padding: 7px 10px 3px; font-family: var(--mono); font-size: 10px; letter-spacing: .08em;
         text-transform: uppercase; color: var(--faint); }
  .note { padding: 9px 10px; font-size: 12.5px; line-height: 1.5; color: var(--muted); }
  .note.err { color: var(--del); }
  .note code { font-family: var(--mono); font-size: 11.5px; }
</style>
