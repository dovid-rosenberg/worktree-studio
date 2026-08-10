<script lang="ts">
  /*
   * Runs: what a finite command did, rather than a pane you have to read.
   *
   * A task used to open a tmux tab, which shows you raw ANSI in a window competing with
   * the agent's tabs and answers none of the questions you actually have — did it pass,
   * how long did it take, what did the last one say. Those are the columns here.
   *
   * The LIST is pushed: `runs` rides the session-state frame, and a run only changes it by
   * starting or finishing, so the status and duration update themselves. The OUTPUT is
   * pulled: a byte-offset tail like LogsPanel's, because streaming every run's stdout over
   * the SSE fan-out would put a test suite's console on the same channel as agent state.
   */
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toasts.svelte.js';
  import { world } from '$lib/stores/world.svelte.js';
  import type { Run, Session } from '../../../../../server/types';
  import { errMessage } from '$lib/errmsg.js';

  let { session }: { session: Session } = $props();

  /** Every worktree this session owns — a feature spans repos, and so do its runs. */
  const paths = $derived(
    new Set(
      [session.worktreePath, ...(session.repos || []).map((r) => r.worktreePath)].filter(
        (p): p is string => !!p,
      ),
    ),
  );

  const runs = $derived((world.view.runs || []).filter((r) => paths.has(r.worktreePath)));

  let selectedId = $state('');
  /** The selected run, falling back to the newest so the panel is never blank. */
  const selected = $derived(runs.find((r) => r.id === selectedId) || runs[0] || null);

  let body = $state<HTMLElement | null>(null);
  let text = $state('');
  let follow = $state(true);

  const fmt = (r: Run): string => {
    const end = r.endedAt ?? Date.now();
    const s = Math.max(0, end - r.startedAt) / 1000;
    return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  };

  const when = (t: number): string => new Date(t).toLocaleTimeString();

  /*
   * Byte-offset tail, self-scheduling.
   *
   * A setTimeout chain rather than setInterval: a slow response must not stack requests
   * behind it. Re-armed only while the run is going — a finished run's log is final, so
   * polling it forever would be a request per second for a file that cannot change.
   */
  $effect(() => {
    const run = selected;
    if (!run) { text = ''; return; }

    let alive = true;
    let offset: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    text = '';

    const tick = async () => {
      if (!alive) return;
      try {
        const q = offset === undefined ? '' : `?offset=${offset}`;
        const res = await api('GET', `/api/v1/runs/${run.id}/log${q}`);
        if (!alive) return;
        if (res.text) {
          const near = !body || body.scrollHeight - body.scrollTop - body.clientHeight < 40;
          text += res.text;
          offset = res.offset;
          if (follow && near) queueMicrotask(() => { if (body) body.scrollTop = body.scrollHeight; });
        } else if (offset === undefined) {
          offset = res.offset;
        }
      } catch { /* a log read must not take the panel with it */ }
      // The run object is a NEW one on every frame, so re-read it from the live list
      // rather than trusting the copy this effect closed over.
      const live = (world.view.runs || []).find((r) => r.id === run.id);
      if (alive && live?.status === 'running') timer = setTimeout(tick, 900);
    };
    tick();

    return () => { alive = false; if (timer) clearTimeout(timer); };
  });

  async function stop(r: Run) {
    try { await api('POST', `/api/v1/runs/${r.id}/stop`, {}); }
    catch (e) { toast(errMessage(e), true); }
  }

  async function rerun(r: Run) {
    try {
      const res = await api('POST', `/api/v1/runs/${r.id}/rerun`, {});
      // Follow the new one: you pressed rerun to watch it, not to keep reading the old
      // output. The list is newest-first, so it is already at the top.
      if (res.ok && res.run?.id) selectedId = res.run.id;
      else if (!res.ok) toast(res.error || 'Could not rerun', true);
    } catch (e) { toast(errMessage(e), true); }
  }

  async function forget(r: Run) {
    try {
      const res = await api('DELETE', `/api/v1/runs/${r.id}`);
      if (!res.ok) toast(res.error || 'Could not remove that run', true);
      else if (selectedId === r.id) selectedId = '';
    } catch (e) { toast(errMessage(e), true); }
  }
</script>

<div class="runs">
  {#if !runs.length}
    <div class="empty">
      <p>Nothing has been run here yet.</p>
      <p class="dim">
        Use <b>▷ Run</b> in the bar below — Studio reads the run configurations your editor
        already has. Tests and builds land here with their output and exit code; anything
        long-lived is tracked as a dev server instead.
      </p>
    </div>
  {:else}
    <div class="list" role="list">
      {#each runs as r (r.id)}
        <div class="row" class:on={selected?.id === r.id} role="listitem">
          <button class="hit" type="button" onclick={() => (selectedId = r.id)}>
            <span class="st {r.status}" title={r.status}></span>
            <span class="nm">{r.name}</span>
            <span class="meta">
              {r.repo} · {fmt(r)}{r.status === 'failed' && r.exitCode != null ? ` · exit ${r.exitCode}` : ''}
            </span>
            <span class="at">{when(r.startedAt)}</span>
          </button>
          {#if r.status === 'running'}
            <button class="btn xs danger" title="Stop this run" onclick={() => stop(r)}>Stop</button>
          {:else}
            <!-- Runs the RECORDED command again, not whatever the config says today —
                 see Runner.rerun. ▷ Run is the one that re-reads the file. -->
            <button
              class="btn xs ghost"
              title={`Run this again — ${r.cmd}`}
              aria-label={`Rerun ${r.name}`}
              onclick={() => rerun(r)}
            >↻</button>
            <button class="btn xs ghost" title="Remove from history" aria-label="Remove run" onclick={() => forget(r)}>✕</button>
          {/if}
        </div>
      {/each}
    </div>

    <div class="out" bind:this={body}>
      {#if selected}
        <div class="cmd" title={selected.cmd}>
          <span class="st {selected.status}"></span>
          <code>{selected.cmd}</code>
          <span class="spacer"></span>
          <label class="chk"><input type="checkbox" bind:checked={follow} /> follow</label>
        </div>
      {/if}
      <pre>{text || 'No output yet.'}</pre>
    </div>
  {/if}
</div>

<style>
  /* Two panes: the history on the left, the selected run's output on the right. */
  .runs { flex:1; min-height:0; display:grid; grid-template-columns:minmax(240px, 30%) 1fr; background:var(--bg); }
  .list { border-right:1px solid var(--border); overflow-y:auto; padding:6px; display:flex; flex-direction:column; gap:2px; }

  .row { display:flex; align-items:center; gap:4px; border-radius:8px; padding-right:5px; }
  .row:hover { background:var(--elevated); }
  .row.on { background:var(--elevated); box-shadow:inset 2px 0 0 var(--brand); }
  .hit { flex:1; min-width:0; display:grid; grid-template-columns:auto 1fr auto; grid-template-areas:'st nm at' 'st meta meta';
         gap:1px 8px; align-items:center; background:none; border:0; padding:7px 8px; cursor:pointer; text-align:left; color:inherit; font:inherit; }
  .hit .nm { grid-area:nm; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .hit .meta { grid-area:meta; font-family:var(--mono); font-size:11px; color:var(--faint); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .hit .at { grid-area:at; font-family:var(--mono); font-size:10.5px; color:var(--faint); }

  /* Status is the first thing you look for, so it is a colour and not a word. */
  .st { grid-area:st; width:9px; height:9px; border-radius:50%; flex:none; background:var(--idle); }
  .st.running { background:var(--working); animation:pulse 1.4s ease-in-out infinite; }
  .st.passed { background:var(--done); }
  .st.failed { background:var(--del); }
  .st.stopped { background:var(--faint); }
  @media (prefers-reduced-motion:reduce) { .st.running { animation:none; } }

  .out { min-width:0; overflow-y:auto; display:flex; flex-direction:column; }
  .cmd { position:sticky; top:0; z-index:1; display:flex; align-items:center; gap:9px; padding:8px 12px;
         background:var(--panel); border-bottom:1px solid var(--border); font-family:var(--mono); font-size:11.5px; color:var(--muted); }
  .cmd code { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .cmd .spacer { flex:1; }
  .chk { display:inline-flex; align-items:center; gap:5px; }
  .chk input { accent-color:var(--brand); }

  .out pre { margin:0; padding:10px 12px; font-family:var(--mono); font-size:12.5px; line-height:1.5;
             color:var(--ink); white-space:pre-wrap; word-break:break-word; }

  .empty { margin:auto; max-width:420px; padding:36px; text-align:center; color:var(--muted); font-size:14px; line-height:1.6; }
  .empty .dim { color:var(--faint); font-size:13px; }
</style>
