<script lang="ts">
  import type { Feature, Worktree } from '../../../../../server/types';
  /*
   * What the dock shows for a feature with no agent.
   *
   * There is no terminal to mount, so this answers the question you actually have about
   * a worktree you are not currently working in: what is in here, and is it merged?
   *
   * It used to open with a row of buttons that were a 1:1 duplicate of the ActionBar's
   * feature branch, sitting directly above the bar that already had them. Those are
   * gone — the bottom bar acts, this reads. What is left is the thing the ActionBar
   * cannot tell you: per-repo branch, ports, merge state, commits ahead of base, and
   * uncommitted files.
   */
  import { api } from '$lib/api.js';
  import { liveMembers } from '$lib/stores/ui.svelte.js';

  let { feature }: { feature: Feature } = $props();

  const ms = $derived(liveMembers(feature));

  /** @param {any} m */
  /*
   * Why this member is not running, in the words of the actual blocker.
   *
   * `canStart` is `!!startCfg && !depsMissing`, and only the deps half ever explained
   * itself. A repo absent from `config.start` produced no button and no reason, so the
   * natural guess was stale deps — wrong, and only an API query said so.
   */
  const memberWhy = (m: Worktree) => {
    if (m.running) return 'running';
    if (m.depsMissing) return 'deps missing';
    if (m.noStartCmd) return `no start command for ${m.repo}`;
    return 'stopped';
  };

  const memberState = (m: Worktree) => (m.session ? m.session.state : (m.running ? 'done' : 'idle'));

  interface RepoRoll {
    repo: string;
    branch: string | null;
    base: string;
    commits: { sha: string; subject: string; author: string; when: string }[];
    uncommitted: { fileCount: number; added: number; deleted: number };
  }

  let roll = $state<RepoRoll[]>([]);
  let rollError = $state('');

  /*
   * Keyed on the feature NAME, not the object: the feature is a new object on every
   * topology frame, so keying the effect on it would refetch several times a second
   * while a stack is running. The name changes only when you select a different feature.
   */
  const featureName = $derived(feature.name);

  $effect(() => {
    const name = featureName;
    let alive = true;
    roll = [];
    rollError = '';
    api('GET', `/api/v1/group/${encodeURIComponent(name)}/commits`)
      .then((d) => { if (alive) roll = d.repos || []; })
      .catch((e) => { if (alive) rollError = e instanceof Error ? e.message : String(e); });
    return () => { alive = false; };
  });

  const rollFor = (repo: string) => roll.find((r) => r.repo === repo) || null;
</script>

<div class="fpane">
  <div class="head">
    <h2>{feature.name}</h2>
    {#if !feature.auto}<span class="src" title="Grouped by config.groups, not by shared name">manual</span>{/if}
    {#if feature.slot != null}
      <span class="badge slot" title="Concurrency slot — its ports are offset by slot·100">slot {feature.slot}</span>
    {/if}
  </div>
  <p class="sub">
    {ms.length} repo{ms.length === 1 ? '' : 's'} · no agent ·
    {feature.auto ? 'grouped by shared worktree name' : 'grouped by config.groups'}
  </p>


  <div class="tablewrap">
    <table class="rtable">
      <thead>
        <tr><th>Repo</th><th>Branch</th><th>Servers</th><th>Ports</th><th>State</th></tr>
      </thead>
      <tbody>
        {#each ms as m (m.path)}
          <tr>
            <td class="r">{m.repo}</td>
            <td>{m.branch || m.wtname}{#if m.merged}<span class="badge merged">✓ merged</span>{/if}</td>
            <td>{memberWhy(m)}</td>
            <td class="ports">{(m.ports || []).length ? m.ports.map((p: number) => m.repo + ':' + p).join(' ') : '—'}</td>
            <td><span class="pill {memberState(m)}">{memberState(m)}</span></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <!-- What the ActionBar cannot tell you, and the reason this pane earns its space. -->
  <h3 class="h3">What is in here</h3>
  {#if rollError}
    <p class="msg bad">{rollError}</p>
  {:else if !roll.length}
    <p class="msg">Reading the branches…</p>
  {:else}
    <div class="rolls">
      {#each ms as m (m.path)}
        {@const r = rollFor(m.repo)}
        <section class="roll">
          <header>
            <span class="rrepo">{m.repo}</span>
            <span class="rbranch">{m.branch || m.wtname}</span>
            {#if r}<span class="rbase">vs {r.base}</span>{/if}
            {#if m.merged}<span class="badge merged">✓ merged</span>{/if}
          </header>
          {#if !r}
            <p class="msg">—</p>
          {:else}
            <p class="rsum">
              <b>{r.commits.length}</b> commit{r.commits.length === 1 ? '' : 's'} ahead
              {#if r.uncommitted.fileCount}
                · <b>{r.uncommitted.fileCount}</b> uncommitted file{r.uncommitted.fileCount === 1 ? '' : 's'}
                <span class="add">+{r.uncommitted.added}</span><span class="del">−{r.uncommitted.deleted}</span>
              {:else}
                · working tree clean
              {/if}
            </p>
            <ul class="clist">
              {#each r.commits.slice(0, 5) as c (c.sha)}
                <li><code>{c.sha.slice(0, 8)}</code> <span class="csub">{c.subject}</span></li>
              {/each}
              {#if r.commits.length > 5}<li class="more">+{r.commits.length - 5} more</li>{/if}
              {#if !r.commits.length}<li class="more">nothing committed on this branch yet</li>{/if}
            </ul>
          {/if}
        </section>
      {/each}
    </div>
  {/if}
</div>

<style>
  .fpane { flex:1; min-height:0; overflow:auto; padding:24px 22px 40px; }
  .head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .head h2 { margin:0; font-size:20px; letter-spacing:-.01em; }
  .sub { margin:5px 0 20px; font-family:var(--mono); font-size:12.5px; color:var(--faint); }

  .tablewrap { overflow-x:auto; border:1px solid var(--border); border-radius:10px; background:var(--panel); }
  .rtable { width:100%; border-collapse:collapse; font-family:var(--mono); font-size:12.5px; min-width:560px; }
  .rtable th { text-align:left; font-size:10.5px; letter-spacing:.09em; text-transform:uppercase; color:var(--faint); font-weight:700; padding:8px 12px; border-bottom:1px solid var(--border); background:var(--elevated); white-space:nowrap; }
  .rtable td { padding:9px 12px; border-bottom:1px solid var(--border); color:var(--muted); }
  .rtable tr:last-child td { border-bottom:none; }
  .rtable td.r { color:var(--ink); }
  .rtable td.ports { color:var(--done); font-variant-numeric:tabular-nums; }
  .badge { font-family:var(--mono); font-size:11px; font-weight:600; padding:2px 8px; border-radius:999px; margin-left:8px; }
  .badge.merged { color:var(--done); background:var(--done-bg); }
  .badge.slot { color:var(--working); background:var(--working-bg); }
  .h3 { margin:26px 0 10px; font-size:14px; font-weight:650; }
  .msg { margin:0; font-size:13.5px; color:var(--muted); }
  .msg.bad { color:var(--waiting); }
  .rolls { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:12px; }
  .roll { border:1px solid var(--border); border-radius:10px; background:var(--panel); padding:12px 13px; min-width:0; }
  .roll header { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:7px; }
  .roll .rrepo { font-weight:640; font-size:13.5px; }
  .roll .rbranch { font-family:var(--mono); font-size:11.5px; color:var(--faint); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .roll .rbase { font-family:var(--mono); font-size:11px; color:var(--muted); }
  .rsum { margin:0 0 8px; font-family:var(--mono); font-size:12px; color:var(--muted); }
  .rsum b { color:var(--ink); }
  .rsum .add { color:var(--add); margin-left:6px; }
  .rsum .del { color:var(--del); margin-left:4px; }
  .clist { margin:0; padding:0; list-style:none; display:flex; flex-direction:column; gap:4px; }
  .clist li { font-family:var(--mono); font-size:11.5px; color:var(--muted); display:flex; gap:7px; min-width:0; }
  .clist code { color:var(--brand); flex:none; }
  .clist .csub { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .clist .more { color:var(--faint); }

  .src { font-family:var(--mono); font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; border:1px solid var(--border); border-radius:5px; padding:1px 6px; color:var(--muted); }
</style>
