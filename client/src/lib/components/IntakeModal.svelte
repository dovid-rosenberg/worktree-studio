<script lang="ts">
  /*
   * New-session intake. One dialog, several pluggable sources: free text, a GitHub /
   * GitLab issue, an Asana task. A source that is not configured is shown disabled
   * rather than hidden, so the absence is legible instead of mysterious.
   */
  import Modal from '$lib/components/Modal.svelte';
  import { activatable } from '$lib/actions/activatable.js';
  import { api } from '$lib/api.js';
  import { world } from '$lib/stores/world.svelte.js';
  import { ui } from '$lib/stores/ui.svelte.js';
  import { overlays } from '$lib/stores/overlays.svelte.js';
  import { toast } from '$lib/stores/toasts.svelte.js';

  const KNOWN = [
    { id: 'freetext', label: 'Free text' },
    { id: 'github', label: 'GitHub' },
    { id: 'gitlab', label: 'GitLab' },
    { id: 'asana', label: 'Asana' },
  ];

  let source = $state('freetext');
  let repo = $state('');
  let text = $state('');
  let name = $state('');
    let issues: {id:string,title:string,subtitle?:string}[] = $state([]);
  let issueId = $state<string|null>(null);
  /** @type {Set<string>} — extra repos this feature will touch. */
  let extra = $state(new Set());
  let loading = $state(false);
  let starting = $state(false);
  let textarea = $state<HTMLTextAreaElement|null>(null);

  const enabled = $derived(new Set(world.sources.map((s: any) => s.id)));
  const isFree = $derived(source === 'freetext');
  const otherRepos = $derived(world.repos.filter((r: any) => r.name !== repo));
  const note = $derived(isFree
    ? 'Boots a real Claude Code session in the repo (CLAUDE.md loaded). The name is optional; the branch is chosen when you promote.'
    : `Seeds the session from ${source}. ${world.sources.find((s: any) => s.id === source && s.needsRepo) ? 'Uses the selected repo.' : ''}`);

  // Default the repo once the topology has arrived, and focus the prompt on open.
  $effect(() => {
    if (!repo && world.repos.length) repo = world.repos[0].name;
  });
  $effect(() => {
    queueMicrotask(() => textarea?.focus());
  });

  /** @param {string} id */
  function pickSource(id: any) {
    source = id;
    issues = [];
    issueId = null;
  }

  async function loadIssues() {
    if (loading) return;
    loading = true;
    try {
      const out = await api('GET', `/api/sources/${source}/items?repo=${encodeURIComponent(repo)}`);
      if (!out.ok) throw new Error(out.error || 'failed');
      issues = out.items || [];
      if (!issues.length) toast('No items found.');
    } catch (e) { toast((e as Error).message, true); }
    finally { loading = false; }
  }

  /** @param {string} n */
  function toggleExtra(n: any) {
    const next = new Set(extra);
    if (next.has(n)) next.delete(n); else next.add(n);
    extra = next;
  }

  async function start() {
    if (starting) return;
        const body: Record<string, any> = { source, repo };
    if (isFree) {
      if (!text.trim()) return toast('Describe what you’re working on first.', true);
      body.text = text;
      if (name.trim()) body.name = name.trim();
    } else {
      if (!issueId) return toast('Pick an item first.', true);
      body.sourceId = issueId;
    }
    if (extra.size) body.additionalRepos = [...extra];
    starting = true;
    try {
      const s = await api('POST', '/api/sessions', body);
      overlays.closeIntake();
      ui.goToSession(s.id);
      toast(`Session started — ${s.title}`);
    } catch (e) { toast((e as Error).message, true); }
    finally { starting = false; }
  }
</script>

<Modal label="New session" onclose={() => overlays.closeIntake()}>
  <div class="modal-head">
    <span class="dot idle"></span><b>New session</b>
    <span class="spacer"></span>
    <button class="btn ghost" title="Close" aria-label="Close" onclick={() => overlays.closeIntake()}>✕</button>
  </div>

  <div class="srctabs">
    {#each KNOWN as t (t.id)}
      {@const dis = !enabled.has(t.id)}
      {#if dis}
        <span class="srctab" data-disabled="true" title="Not configured — see Connections & settings">{t.label}</span>
      {:else}
        <span class="srctab" class:on={source === t.id} use:activatable={() => pickSource(t.id)}>{t.label}</span>
      {/if}
    {/each}
  </div>

  <div class="modal-body">
    <div class="field">
      <label for="m-repo">Repo</label>
      <select id="m-repo" class="select" bind:value={repo} onchange={() => { issues = []; }}>
        {#each world.repos as r (r.name)}<option value={r.name}>{r.name}</option>{/each}
      </select>
    </div>

    {#if isFree}
      <div class="field">
        <label for="m-text">What are you working on?</label>
        <textarea
          id="m-text"
          class="textarea"
          rows="4"
          placeholder="Describe the feature or bug…"
          bind:value={text}
          bind:this={textarea}
        ></textarea>
      </div>
    {:else}
      <div class="field">
        <label for="m-load">Pick an item <button id="m-load" class="btn xs" disabled={loading} onclick={loadIssues}>{loading ? 'Loading…' : 'Load'}</button></label>
        <div class="issuelist">
          {#if !issues.length}
            <div class="modal-note">Click “Load” to fetch {source === 'asana' ? 'your Asana tasks' : 'open issues'}.</div>
          {/if}
          {#each issues as it (it.id)}
            <div class="issue" class:sel={issueId === it.id} use:activatable={() => (issueId = it.id)}>
              <span class="num">{it.subtitle || it.id}</span> <span>{it.title}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <div class="field">
      <label for="m-name">Short name <span class="hint">(optional — names the session &amp; its branch)</span></label>
      <input id="m-name" class="input" placeholder="e.g. invoice-order-fix" bind:value={name} />
    </div>

    <div class="field">
      <span class="lbl">Also touches <span class="hint">(optional — other repos this feature will change)</span></span>
      <div class="repochecks">
        {#each otherRepos as r (r.name)}
          <label class="repocheck">
            <input type="checkbox" checked={extra.has(r.name)} onchange={() => toggleExtra(r.name)} /> {r.name}
          </label>
        {:else}
          <span class="hint">no other repos</span>
        {/each}
      </div>
    </div>

    <div class="modal-note">{note}</div>
  </div>

  <div class="modal-foot">
    <span class="foot-note">→ {world.mux} session · seeds first message</span>
    <span class="spacer"></span>
    <button class="btn" onclick={() => overlays.closeIntake()}>Cancel</button>
    <button class="btn primary" disabled={starting} onclick={start}>{starting ? 'Starting…' : 'Start session ↵'}</button>
  </div>
</Modal>

<style>
  .modal-head { display:flex; align-items:center; gap:9px; padding:14px 16px; border-bottom:1px solid var(--border); font-size:14px; }
  .srctabs { display:flex; gap:4px; padding:12px 16px 0; flex-wrap:wrap; }
  .srctab { font-size:12.5px; font-weight:600; color:var(--muted); padding:7px 13px; border-radius:9px 9px 0 0; border:1px solid transparent; border-bottom:none; cursor:pointer; }
  .srctab.on { color:var(--ink); background:var(--elevated); border-color:var(--border); }
  .srctab[data-disabled="true"] { opacity:.4; cursor:not-allowed; }
  .modal-body { padding:16px; background:var(--elevated); border-top:1px solid var(--border); display:flex; flex-direction:column; gap:14px; overflow-y:auto; }
  .modal-foot { display:flex; align-items:center; gap:10px; padding:13px 16px; border-top:1px solid var(--border); }
  .foot-note { font-family:var(--mono); font-size:11px; color:var(--faint); }
  .field { display:flex; flex-direction:column; gap:6px; }
  .field label, .field .lbl { font-family:var(--mono); font-size:10.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--faint); display:flex; align-items:center; gap:8px; }
  .hint { text-transform:none; letter-spacing:0; color:var(--faint); }
  .issuelist { display:flex; flex-direction:column; gap:5px; max-height:200px; overflow-y:auto; }
  .issue { display:flex; align-items:center; gap:9px; background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:8px 10px; cursor:pointer; font-size:13px; }
  .issue:hover { border-color:var(--border-strong); }
  .issue.sel { border-color:var(--brand); }
  .issue .num { font-family:var(--mono); color:var(--brand); font-weight:700; font-size:11.5px; }
  .modal-note { font-family:var(--mono); font-size:11px; color:var(--faint); }
  .repochecks { display:flex; flex-wrap:wrap; gap:8px; }
  .repocheck { font-family:var(--mono); font-size:12px; background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:5px 10px; display:inline-flex; align-items:center; gap:5px; cursor:pointer; text-transform:none; letter-spacing:0; }
  .repocheck input { accent-color:var(--brand); }
</style>
