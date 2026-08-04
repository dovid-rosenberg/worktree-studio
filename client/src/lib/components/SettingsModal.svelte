<script lang="ts">
  /*
   * Connections & settings. Reads GET /api/settings on open and writes the whole form
   * back with POST /api/settings on save.
   *
   * Note the server treats `start`, `editors` and `groups` as FULL REPLACEMENTS: a row
   * deleted here is deleted on disk. Rows without the fields that make them meaningful
   * are dropped by the server, and dropped here too so the two agree about what was
   * saved.
   */
  import Modal from '$lib/components/Modal.svelte';
  import { api } from '$lib/api.js';
  import { world } from '$lib/stores/world.svelte.js';
  import { overlays } from '$lib/stores/overlays.svelte.js';
  import { toast } from '$lib/stores/toasts.svelte.js';
  import { notify } from '$lib/stores/notify.svelte.js';

  let loaded = $state(false);
  let saving = $state(false);
  let error = $state('');

  let baseDirs = $state('');
  let tools = $state({ gh: false, glab: false });
  let githubAuthed = $state(false);
  let gl = $state({ enabled: false, host: 'https://gitlab.com', project: '', token: '' });
  let as = $state({ enabled: false, token: '', workspace: '' });
  let nt = $state({ waiting: true, sound: true, idle: false });

  // Editable row lists. Each row carries a stable `key` so `{#each}` can be keyed —
  // otherwise deleting row 2 of 4 re-seeds the inputs of rows 3 and 4 with each other's
  // values, which is exactly the class of bug this port exists to remove.
  let rowKey = 0;
    let startRows: {key:number, repo:string, cmd:string, ports:string}[] = $state([]);
    let editorRows: {key:number, name:string, open:string, openGroup:string}[] = $state([]);
    let groupRows: {key:number, name:string, members:string}[] = $state([]);

  $effect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await api('GET', '/api/v1/settings');
        if (!alive) return;
        const src = d.sources || {};
        baseDirs = (d.baseDirs || []).join('\n');
        tools = d.tools || { gh: false, glab: false };
        githubAuthed = !!d.githubAuthed;
        gl = { enabled: false, host: 'https://gitlab.com', project: '', token: '', ...(src.gitlab || {}) };
        as = { enabled: false, token: '', workspace: '', ...(src.asana || {}) };
        nt = { waiting: true, sound: true, idle: false, ...(d.notify || {}) };
        notify.prefs = { ...notify.prefs, ...nt }; // keep the live prefs in step with disk
        startRows = Object.entries(d.start || {}).map(([repo, v]) => ({
          key: ++rowKey,
          repo,
          cmd: (v && (v as any).cmd) || '',
          ports: (((v && (v as any).ports) || [])).join(' '),
        }));
        editorRows = Object.entries(d.editors || {}).map(([name, v]) => ({
          key: ++rowKey,
          name,
          open: (v && (v as any).open) || '',
          openGroup: (v && (v as any).openGroup) || '',
        }));
        groupRows = (d.groups || []).map((g: { name?: string; members?: string[] }) => ({
          key: ++rowKey,
          name: g.name || '',
          members: (g.members || []).join(', '),
        }));
        loaded = true;
      } catch (e) {
        if (alive) error = (e as Error).message;
      }
    })();
    return () => { alive = false; };
  });

  async function save() {
    if (saving) return;
    saving = true;
        const start: Record<string, {cmd:string, ports:number[]}> = {};
    for (const r of startRows) {
      const repo = r.repo.trim();
      const cmd = r.cmd.trim();
      if (!repo || !cmd) continue;
      start[repo] = {
        cmd,
        ports: r.ports.split(/[\s,]+/).map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n > 0),
      };
    }
        const editors: Record<string, {open:string, openGroup?:string}> = {};
    for (const r of editorRows) {
      const name = r.name.trim();
      const open = r.open.trim();
      if (!name || !open) continue;
      editors[name] = r.openGroup ? { open, openGroup: r.openGroup } : { open };
    }
    const groups = groupRows
      .map((r) => ({ name: r.name.trim(), members: r.members.split(',').map((s) => s.trim()).filter(Boolean) }))
      .filter((g) => g.name && g.members.length);

    notify.prefs = { ...notify.prefs, ...nt };
    try {
      await api('POST', '/api/v1/settings', {
        sources: {
          gitlab: { enabled: gl.enabled, host: gl.host.trim(), project: gl.project.trim(), token: gl.token.trim() },
          asana: { enabled: as.enabled, token: as.token.trim(), workspace: as.workspace.trim() },
        },
        baseDirs: baseDirs.split('\n').map((s) => s.trim()).filter(Boolean),
        notify: nt,
        start,
        editors,
        groups,
      });
      overlays.closeSettings();
      toast('Settings saved');
    } catch (e) { toast((e as Error).message, true); }
    finally { saving = false; }
  }
</script>

<Modal label="Connections & settings" onclose={() => overlays.closeSettings()}>
  <div class="modal-head">
    <span>⚙</span><b>Connections &amp; settings</b>
    <span class="spacer"></span>
    <button class="btn ghost" title="Close" aria-label="Close" onclick={() => overlays.closeSettings()}>✕</button>
  </div>

  <div class="modal-body">
    {#if error}
      <div class="conn-status"><span class="warn">Could not load settings: {error}</span></div>
    {:else if !loaded}
      <div class="conn-status">Loading…</div>
    {:else}
      <div class="field">
        <label for="set-basedirs">Repo roots <span class="hint">— folders scanned for your repos (one per line)</span></label>
        <textarea id="set-basedirs" class="textarea" rows="3" placeholder="~/Desktop/ab-code" bind:value={baseDirs}></textarea>
      </div>

      <div class="field">
        <span class="lbl">GitHub <span class="hint">— uses the <code>gh</code> CLI</span></span>
        <div class="conn-status">
          {#if tools.gh}
            {#if githubAuthed}<span class="ok">✓ gh installed &amp; authenticated</span>
            {:else}<span class="warn">gh installed — run <code>gh auth login</code></span>{/if}
          {:else}
            <span class="warn">gh not installed (brew install gh)</span>
          {/if}
        </div>
      </div>

      <div class="field">
        <label class="inline"><input type="checkbox" bind:checked={gl.enabled} /> GitLab <span class="hint">{tools.glab ? '— glab CLI available' : '— uses API token'}</span></label>
        <input class="input" placeholder="https://gitlab.com" bind:value={gl.host} aria-label="GitLab host" />
        <input class="input" placeholder="group/project (for API mode)" bind:value={gl.project} aria-label="GitLab project" />
        <input class="input" type="password" placeholder="Personal access token" bind:value={gl.token} aria-label="GitLab token" />
      </div>

      <div class="field">
        <label class="inline"><input type="checkbox" bind:checked={as.enabled} /> Asana <span class="hint">— API token</span></label>
        <input class="input" type="password" placeholder="Personal access token" bind:value={as.token} aria-label="Asana token" />
        <input class="input" placeholder="Workspace GID" bind:value={as.workspace} aria-label="Asana workspace" />
      </div>

      <div class="field">
        <span class="lbl">Notifications <span class="hint">— when a session needs you</span></span>
        <label class="chk">
          <input type="checkbox" bind:checked={nt.waiting} onchange={() => nt.waiting && notify.requestPermission()} />
          Desktop notification when a session needs input
        </label>
        <label class="chk"><input type="checkbox" bind:checked={nt.sound} /> Play a sound</label>
        <label class="chk"><input type="checkbox" bind:checked={nt.idle} /> Notify when a turn completes</label>
      </div>

      <datalist id="setRepoList">
        {#each world.repos as r (r.name)}<option value={r.name}></option>{/each}
      </datalist>

      <div class="setsec">
        <span class="lbl">Dev servers <span class="lbl-note">— per-repo launch command &amp; ports (space/comma separated)</span></span>
        {#each startRows as row (row.key)}
          <div class="srvcfg-row">
            <input list="setRepoList" bind:value={row.repo} placeholder="repo…" aria-label="Repo" />
            <input bind:value={row.cmd} placeholder="command…" aria-label="Command" />
            <input bind:value={row.ports} placeholder="ports" aria-label="Ports" />
            <button class="btn ghost xs" title="Remove" aria-label="Remove" onclick={() => (startRows = startRows.filter((r) => r.key !== row.key))}>✕</button>
          </div>
        {/each}
        <button class="btn ghost xs add" onclick={() => (startRows = [...startRows, { key: ++rowKey, repo: '', cmd: '', ports: '' }])}>＋ add server</button>
      </div>

      <div class="setsec">
        <span class="lbl">Editors <span class="lbl-note">— <code>{'{path}'}</code> is the worktree path</span></span>
        {#each editorRows as row (row.key)}
          <div class="srvcfg-row cols3">
            <input bind:value={row.name} placeholder="name…" aria-label="Editor name" />
            <input bind:value={row.open} placeholder="open command with {'{path}'}…" aria-label="Open command" />
            <button class="btn ghost xs" title="Remove" aria-label="Remove" onclick={() => (editorRows = editorRows.filter((r) => r.key !== row.key))}>✕</button>
          </div>
        {/each}
        <button class="btn ghost xs add" onclick={() => (editorRows = [...editorRows, { key: ++rowKey, name: '', open: '', openGroup: '' }])}>＋ add editor</button>
      </div>

      <div class="setsec">
        <span class="lbl">Feature groups <span class="lbl-note">— members are <code>repo/branch-or-wtname</code> refs, comma-separated</span></span>
        {#each groupRows as row (row.key)}
          <div class="srvcfg-row cols3">
            <input bind:value={row.name} placeholder="group name…" aria-label="Group name" />
            <input bind:value={row.members} placeholder="repo/branch, repo/branch…" aria-label="Group members" />
            <button class="btn ghost xs" title="Remove" aria-label="Remove" onclick={() => (groupRows = groupRows.filter((r) => r.key !== row.key))}>✕</button>
          </div>
        {/each}
        <button class="btn ghost xs add" onclick={() => (groupRows = [...groupRows, { key: ++rowKey, name: '', members: '' }])}>＋ add group</button>
      </div>
    {/if}
  </div>

  <div class="modal-foot">
    <span class="foot-note">Saved to ~/.config/worktree-studio/config.json</span>
    <span class="spacer"></span>
    <button class="btn" onclick={() => overlays.closeSettings()}>Close</button>
    <button class="btn primary" disabled={!loaded || saving} onclick={save}>{saving ? 'Saving…' : 'Save'}</button>
  </div>
</Modal>

<style>
  .modal-head { display:flex; align-items:center; gap:9px; padding:14px 16px; border-bottom:1px solid var(--border); font-size:14px; }
  .modal-body { padding:16px; background:var(--elevated); border-top:1px solid var(--border); display:flex; flex-direction:column; gap:14px; overflow-y:auto; }
  .modal-foot { display:flex; align-items:center; gap:10px; padding:13px 16px; border-top:1px solid var(--border); }
  .foot-note { font-family:var(--mono); font-size:11px; color:var(--faint); }
  .field { display:flex; flex-direction:column; gap:6px; }
  .field label, .field .lbl { font-family:var(--mono); font-size:10.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--faint); display:flex; align-items:center; gap:8px; }
  .field label.inline input[type="checkbox"] { vertical-align:middle; margin-right:4px; accent-color:var(--brand); }
  .hint, .lbl-note { text-transform:none; letter-spacing:0; color:var(--faint); }
  .chk { display:inline-flex; align-items:center; gap:6px; font-family:var(--mono); font-size:11px; color:var(--muted); text-transform:none; letter-spacing:0; }
  .chk input { accent-color:var(--brand); }
  .conn-status { font-family:var(--mono); font-size:12px; color:var(--muted); }
  .conn-status .ok { color:var(--done); }
  .conn-status .warn { color:var(--waiting); }
  .setsec { display:flex; flex-direction:column; gap:9px; }
  .setsec > .lbl { font-family:var(--mono); font-size:10.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--faint); display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .setsec .add { align-self:flex-start; }
  .srvcfg-row { display:grid; grid-template-columns:120px 1fr 90px 30px; gap:8px; align-items:center; }
  .srvcfg-row.cols3 { grid-template-columns:120px 1fr 30px; }
  .srvcfg-row input { background:var(--panel); border:1px solid var(--border-strong); border-radius:7px; padding:6px 9px; color:var(--ink); font-family:var(--mono); font-size:11.5px; width:100%; }
</style>
