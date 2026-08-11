<script lang="ts">
import type { Session, SessionServerRepo } from '../../../../../server/types';
/*
 * Live dev-server tail. `GET /api/servers/logs?worktreePath=&offset=` returns the
 * bytes after `offset`, so this is a byte-offset poll rather than a stream.
 *
 * The polling half lives in lib/tail.ts, shared with RunsPanel — it was written twice and
 * the two copies had drifted on every value they share. What stays here is what only this
 * panel does: classify each line by level, and buffer the trailing partial line so a line
 * split across two polls renders as one line instead of two. (RunsPanel needs no buffer:
 * it keeps one string, where a split line reassembles itself.)
 */
import { api } from '$lib/api.js';
import { world } from '$lib/stores/world.svelte.js';
import { MAX_LOG_LINES, tailLog } from '$lib/tail.js';

let { session }: { session: Session } = $props();

/** Every repo of this session's shared workspace owns a per-worktree log file. */
const repos = $derived((world.servers[session.id] && world.servers[session.id].repos) || []);
let selectedPath = $state('');
let follow = $state(true);
let lines: { id: number; text: string; cls: string; partial: boolean }[] = $state([]);
let tailing = $state(false);
let body = $state<HTMLElement | null>(null);

let lineId = 0;
/** Trailing incomplete line, prepended to the next chunk. */
let partial = '';

// Prefer the last selection if it is still a repo of this session, else a running
// server, else the first — the same fallback order the old panel used.
$effect(() => {
  const list = repos;
  if (list.some((r) => r.worktreePath === selectedPath)) return;
  const pick = list.find((r) => r.running) || list[0];
  selectedPath = pick ? pick.worktreePath : '';
});

$effect(() => {
  const path = selectedPath;
  lines = [];
  partial = '';
  if (!path) {
    tailing = false;
    return;
  }
  tailing = true;
  const stop = tailLog({
    fetch: (offset) =>
      api(
        'GET',
        `/api/v1/servers/logs?worktreePath=${encodeURIComponent(path)}${offset === undefined ? '' : `&offset=${offset}`}`,
      ),
    onText: append,
    scroller: () => body,
    follow: () => follow,
    // Slower than the runs tail: a dev server log is ambient, not something you are
    // waiting on the end of.
    interval: 1500,
  });
  return () => {
    stop();
    tailing = false;
  };
});

/** @param {string} chunk */
function append(chunk: string) {
  const combined = partial + chunk;
  const parts = combined.split('\n');
  partial = parts.pop() ?? '';
  const next = lines.filter((l) => !l.partial);
  for (const raw of parts) next.push({ id: ++lineId, ...classify(raw), partial: false });
  if (partial) next.push({ id: ++lineId, ...classify(partial), partial: true });
  // Cap unbounded growth: keep only the most recent MAX_LOG_LINES.
  lines = next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
}

/** Light level colouring, matching the old regexes exactly. @param {string} raw */
function classify(raw: string) {
  let cls = '';
  if (/(error|fatal|exception|failed|✗|\bECONN)/i.test(raw)) cls = 'e';
  else if (/(warn|deprecated)/i.test(raw)) cls = 'w';
  else if (/(ready|listening|compiled|success|✓)/i.test(raw)) cls = 'ok';
  return { text: raw, cls };
}

/** @param {any} r */
function optionLabel(r: SessionServerRepo) {
  const ports = r.ports && r.ports.length ? ' ' + r.ports.map((p: number) => ':' + p).join(' ') : '';
  return `${r.repo}${ports}${r.running ? '' : ' (stopped)'}`;
}

/** Leading timestamp is dimmed; everything else is plain text. @param {string} t */
function splitTs(t: string) {
  const m = t.match(/^\s*(\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?)/);
  return m ? { ts: m[1], rest: t.slice(m[0].length) } : { ts: '', rest: t };
}
</script>

<div class="logs">
  <div class="logs-head">
    <span>tail</span>
    <select class="select logs-select" bind:value={selectedPath} disabled={!repos.length} aria-label="Log source">
      {#if !repos.length}<option value="">no repos</option>{/if}
      {#each repos as r (r.worktreePath)}<option value={r.worktreePath}>{optionLabel(r)}</option>{/each}
    </select>
    <label class="chk"><input type="checkbox" bind:checked={follow} /> follow</label>
    <button class="btn xs" onclick={() => { lines = []; partial = ''; }}>Clear</button>
    {#if tailing}<span class="tailing"><i></i>tailing</span>{/if}
  </div>

  <div class="logbody" bind:this={body}>
    {#if !selectedPath}
      <div class="logs-hint">Promote and start a dev server to see logs.</div>
    {:else if !lines.length}
      <div class="logs-hint">No logs yet — start this feature’s dev server.</div>
    {:else}
      {#each lines as l (l.id)}
        {@const p = splitTs(l.text)}
        <div class="logline {l.cls}">{#if p.ts}<span class="t">{p.ts}</span>{/if}{p.rest || (p.ts ? '' : ' ')}</div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .logs { flex:1; min-height:0; display:flex; flex-direction:column; background:var(--term-bg); }
  .logs-head { display:flex; align-items:center; gap:10px; padding:7px 12px; background:var(--elevated); border-bottom:1px solid var(--border); font-family:var(--mono); font-size:12px; color:var(--muted); flex:none; }
  .logs-select { width:auto; padding:3px 6px; font-size:12px; }
  .chk { display:inline-flex; align-items:center; gap:6px; font-family:var(--mono); font-size:12px; color:var(--muted); }
  .chk input { accent-color:var(--brand); }
  .tailing { display:inline-flex; align-items:center; gap:6px; color:var(--done); margin-left:auto; }
  .tailing i { width:7px; height:7px; border-radius:50%; background:var(--done); display:inline-block; animation:pulse 1.1s infinite; }
  @media (prefers-reduced-motion:reduce){ .tailing i { animation:none; } }
  .logbody { flex:1; overflow:auto; padding:9px 12px; font-family:var(--mono); font-size:13px; line-height:1.55; color:#c6ccd6; }
  .logline { white-space:pre-wrap; word-break:break-word; }
  .logline .t { color:var(--faint); }
  .logline.ok { color:var(--done); } .logline.w { color:var(--waiting); } .logline.e { color:var(--del); }
  .logs-hint { color:var(--faint); font-family:var(--mono); font-size:13px; padding:14px 4px; }
</style>
