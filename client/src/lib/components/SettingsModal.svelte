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
  import DirPicker from '$lib/components/DirPicker.svelte';
  import { api } from '$lib/api.js';
  import { world } from '$lib/stores/world.svelte.js';
  import { uiConfirm } from '$lib/stores/dialog.svelte.js';
  import { overlays } from '$lib/stores/overlays.svelte.js';
  import { toast } from '$lib/stores/toasts.svelte.js';
  import { notify } from '$lib/stores/notify.svelte.js';
  import { moveItem, reorderable } from '$lib/actions/reorderable.js';
  import { errMessage } from '$lib/errmsg.js';

  let loaded = $state(false);
  let saving = $state(false);
  let error = $state('');

  /*
   * Repo roots as ROWS, not a textarea.
   *
   * A textarea makes the list look like prose: no add/remove affordance, no per-entry
   * validation, no way to reorder — and order matters, because the roots are scanned in
   * order. Every other list in this modal is rows; this one was the odd one out.
   */
  let rootRows: {key:number, path:string}[] = $state([]);
  /*
   * Which root row has the folder picker open, by row KEY not index.
   *
   * The rows are draggable and removable, so an index identifies a different row a moment
   * later — the same reason every row here is keyed by `key` in its `{#each}`.
   */
  let picking = $state<number | null>(null);
  const pickingRow = $derived(picking === null ? null : rootRows.find((r) => r.key === picking) || null);
  /**
   * Hand-written run configurations, per repo.
   *
   * The MANUAL half. Studio discovers your editor's configs live from each worktree, so
   * these are only for what no editor config expresses — and they were hand-edit-only,
   * needing a JSON edit and a daemon restart.
   */
  let runRows: {key:number, repo:string, name:string, cmd:string, kind:string}[] = $state([]);
  /** Which editor "Open in editor" uses. The server has always accepted it; nothing sent it. */
  let defaultEditor = $state('');
  let tools = $state({ gh: false, glab: false });
  let githubAuthed = $state(false);
  let gl = $state({ enabled: false, host: 'https://gitlab.com', project: '', token: '' });
  let as = $state({ enabled: false, token: '', workspace: '' });
  let nt = $state({ waiting: true, sound: true, idle: false });
  /** Concurrency knobs the form owns. `repos` (the port map) is not editable here. */
  let conc = $state<{ maxSlots: number; slotPolicy: 'free-ports' | 'lowest' }>({
    maxSlots: 5,
    slotPolicy: 'free-ports',
  });

  // Editable row lists. Each row carries a stable `key` so `{#each}` can be keyed —
  // otherwise deleting row 2 of 4 re-seeds the inputs of rows 3 and 4 with each other's
  // values, which is exactly the class of bug this port exists to remove.
  let rowKey = 0;

  /*
   * DIRTY TRACKING, because closing this form throws the whole thing away.
   *
   * It is a large multi-section form — repo roots, dev-server commands, editor commands,
   * run configurations, feature groups, three API tokens — held entirely in local state
   * and written only by save(). Escape, or a stray click on the backdrop, called
   * closeSettings() unconditionally: minutes of typing gone, with no warning and nothing
   * to undo it with.
   *
   * Serialising is enough here and cheaper than tracking each field: the form is small,
   * this runs on close and on nothing else, and `key` is excluded because it is a
   * rendering id that changes when rows are added — not an edit the user made.
   */
  let pristine = '';

  /**
   * The five panels, and which of three groups each belongs to.
   *
   * Ordered by how often you come here for them, not alphabetically. The GROUP is what a
   * flat tab strip could not express: repos, dev servers and editors are all about your
   * code; the trackers and forges are somebody else's server; notifications are Studio
   * itself.
   */
  const SECTIONS = [
    { id: 'repos', label: 'Repos & groups', glyph: '◧', group: 'code' },
    { id: 'servers', label: 'Dev servers', glyph: '▶', group: 'code' },
    { id: 'editors', label: 'Editors', glyph: '↗', group: 'code' },
    { id: 'conn', label: 'Connections', glyph: '◎', group: 'out' },
    { id: 'notify', label: 'Notifications', glyph: '◔', group: 'app' },
  ] as const;

  /** Not persisted: which panel you were last on is not a preference, it is where you were. */
  type SectionId = (typeof SECTIONS)[number]['id'];
  const isSection = (s: string | null): s is SectionId => SECTIONS.some((x) => x.id === s);
  /*
   * A caller may name the panel it needs — "Asana is not connected" opens Connections
   * rather than the default and a hunt. Read once, at construction: the modal is created
   * when it opens, so this IS "on open", and making it an effect would yank the panel back
   * under anyone who then clicked elsewhere in the sidebar.
   */
  let tab = $state<SectionId>(isSection(overlays.settingsSection) ? overlays.settingsSection : 'repos');

  /*
   * Connecting Asana: prove the token, learn who it belongs to, pick a workspace.
   *
   * Checked on a button press rather than on every keystroke — it is a network call
   * against a value still being typed, and a 401 per character is noise. Pressing Connect
   * is the signal that the token is complete.
   */
  let asanaWorkspaces = $state<Array<{ gid: string; name: string; tasks: number }>>([]);
  let asanaWho = $state('');
  let asanaLoading = $state(false);
  let asanaError = $state('');

  /** The chosen workspace's NAME — a gid on screen tells a human nothing. */
  const asanaWorkspaceName = $derived(
    asanaWorkspaces.find((w) => w.gid === as.workspace)?.name || '',
  );

  async function connectAsana() {
    asanaLoading = true;
    asanaError = '';
    try {
      const r = await api('POST', '/api/v1/sources/asana/verify', { token: as.token.trim() });
      if (!r.ok) throw new Error(r.error || 'could not reach Asana');
      asanaWho = r.name || '';
      asanaWorkspaces = r.workspaces || [];
      if (!asanaWorkspaces.length) {
        asanaError = 'that token can see no workspaces';
        return;
      }
      /*
       * ENABLE IT. This is the whole fix: `enabled` used to be a separate checkbox, so a
       * correct token and workspace could sit there inert with nothing saying so.
       * Connecting is the statement of intent, so connecting is what turns it on.
       *
       * With one workspace there is nothing to choose, so it completes here; with several
       * the picker appears and "Use this" finishes it.
       */
      if (asanaWorkspaces.length === 1) {
        as.workspace = asanaWorkspaces[0].gid;
        as.enabled = true;
      } else {
        /*
         * Several workspaces: pre-select the one with your work in it (verify sorts by
         * task count) but do NOT auto-enable — with a real choice to make, silently
         * making it is how you end up connected to the wrong one, which is exactly what
         * happened here. The user confirms with "Use this".
         */
        if (!asanaWorkspaces.some((w) => w.gid === as.workspace)) {
          as.workspace = asanaWorkspaces[0].gid;
        }
      }
    } catch (e) {
      asanaError = errMessage(e);
      asanaWorkspaces = [];
      asanaWho = '';
    } finally {
      asanaLoading = false;
    }
  }

  function disconnectAsana() {
    as = { enabled: false, token: '', workspace: '' };
    asanaWorkspaces = [];
    asanaWho = '';
    asanaError = '';
  }

  function snapshot(): string {
    const rows = <T extends { key: number }>(list: T[]) =>
      list.map(({ key: _key, ...rest }) => rest);
    return JSON.stringify({
      roots: rows(rootRows),
      start: rows(startRows),
      editors: rows(editorRows),
      runs: rows(runRows),
      groups: rows(groupRows),
      defaultEditor,
      gl,
      as,
      nt,
    });
  }

  /** Close, asking first when there is unsaved work to lose. */
  async function tryClose() {
    if (loaded && snapshot() !== pristine) {
      const ok = await uiConfirm('Discard your unsaved changes to these settings?', {
        title: 'Unsaved changes',
        okLabel: 'Discard',
        danger: true,
      });
      if (!ok) return;
    }
    overlays.closeSettings();
  }
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
        rootRows = (d.baseDirs || []).map((path: string) => ({ key: ++rowKey, path }));
        runRows = Object.entries(d.runConfigs || {}).flatMap(([repo, list]) =>
          ((list || []) as { name?: string; cmd?: string; kind?: string }[]).map((c) => ({
            key: ++rowKey, repo, name: c.name || '', cmd: c.cmd || '', kind: c.kind === 'server' ? 'server' : 'task',
          })),
        );
        defaultEditor = d.defaultEditor || '';
        tools = d.tools || { gh: false, glab: false };
        githubAuthed = !!d.githubAuthed;
        gl = { enabled: false, host: 'https://gitlab.com', project: '', token: '', ...(src.gitlab || {}) };
        as = { enabled: false, token: '', workspace: '', ...(src.asana || {}) };
        conc = { maxSlots: 5, slotPolicy: 'free-ports', ...(d.concurrency || {}) };
        nt = { waiting: true, sound: true, idle: false, ...(d.notify || {}) };
        notify.prefs = { ...notify.prefs, ...nt }; // keep the live prefs in step with disk
        /*
         * `start` has two shapes on disk: `{ cmd, ports }` and the bare string form,
         * `"repo": "npm start"`. Reading only the first put an EMPTY command in the row,
         * and an empty command is dropped on save — so opening this modal and pressing
         * Save deleted every string-form entry without saying anything.
         */
        startRows = Object.entries(d.start || {}).map(([repo, v]) => ({
          key: ++rowKey,
          repo,
          cmd: typeof v === 'string' ? v : (v as { cmd?: string })?.cmd || '',
          ports: (typeof v === 'string' ? [] : (v as { ports?: number[] })?.ports || []).join(' '),
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
        // The baseline for dirty tracking — taken AFTER the load, so the values the
        // server sent are not themselves counted as edits.
        pristine = snapshot();
      } catch (e) {
        if (alive) error = errMessage(e);
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
      const saved = await api('POST', '/api/v1/settings', {
        sources: {
          gitlab: { enabled: gl.enabled, host: gl.host.trim(), project: gl.project.trim(), token: gl.token.trim() },
          asana: { enabled: as.enabled, token: as.token.trim(), workspace: as.workspace.trim() },
        },
        baseDirs: rootRows.map((r) => r.path.trim()).filter(Boolean),
        concurrency: { maxSlots: Number(conc.maxSlots), slotPolicy: conc.slotPolicy },
        // Grouped back into { repo: [config] }, which is the shape on disk. A row missing
        // the fields that make it runnable is dropped, exactly as the server would.
        runConfigs: runRows.reduce<Record<string, { name: string; cmd: string; kind: string }[]>>((acc, r) => {
          const repo = r.repo.trim();
          const name = r.name.trim();
          const cmd = r.cmd.trim();
          if (!repo || !name || !cmd) return acc;
          (acc[repo] ||= []).push({ name, cmd, kind: r.kind });
          return acc;
        }, {}),
        // Only send a name that still exists, or the server would pin "Open in editor"
        // to an editor the user just deleted.
        defaultEditor: editors[defaultEditor] ? defaultEditor : Object.keys(editors)[0] || '',
        notify: nt,
        start,
        editors,
        groups,
      });
      overlays.closeSettings();
      /*
       * Report a folder that does not exist. The save really did succeed — the path may
       * be on an unmounted volume — but the scan will find nothing there and the rail
       * will empty, and previously nothing connected those two facts to the typo that
       * caused them.
       */
      const warnings: string[] = saved?.warnings || [];
      if (warnings.length) toast(warnings.join(' · '), true);
      else toast('Settings saved');
    } catch (e) { toast(errMessage(e), true); }
    finally { saving = false; }
  }

  /**
   * Reorder helper shared by every list.
   *
   * Takes and returns the array rather than mutating in place: `$state` arrays reassign
   * to notify, and a helper that spliced would update the data without redrawing.
   */
  const move = <T,>(list: T[], from: number, to: number): T[] => moveItem(list, from, to);

  /** Keyboard equivalent of a drag — dragging serves a mouse and nothing else. */
  function nudge<T>(list: T[], i: number, by: number): T[] {
    return moveItem(list, i, Math.max(0, Math.min(list.length - 1, i + by)));
  }
</script>

<Modal panelClass="settings" label="Settings" onclose={tryClose}>
  <div class="modal-head">
    <span>⚙</span><b>Settings</b>
    <span class="spacer"></span>
    <button class="btn ghost" title="Close" aria-label="Close" onclick={tryClose}>✕</button>
  </div>

  <!--
    A SIDEBAR, not nine sections in one scroll.
    The form was 568 lines in a single column — repo roots, three integrations,
    notifications, dev servers, editors, run configurations and feature groups, stacked.
    Five panels now, under three headings that say something the panel names cannot: repos,
    dev servers and editors are all about YOUR CODE, while the trackers and forges are
    ELSEWHERE. That is the distinction you navigate by.

    160px of sidebar plus the 560px the form has always had — so nothing got narrower.
  -->
  <div class="setwrap">
    {#if error}
      <div class="conn-status"><span class="warn">Could not load settings: {error}</span></div>
    {:else if !loaded}
      <div class="conn-status">Loading…</div>
    {:else}
      <!-- A div, not a <nav>: a tablist is a widget role, and putting it on a landmark
           element is a contradiction the linter is right to flag. -->
      <div class="setnav" role="tablist" aria-label="Settings sections">
        <span class="navsec">Your code</span>
        {#each SECTIONS.filter((s) => s.group === 'code') as s (s.id)}
          <button
            role="tab"
            aria-selected={tab === s.id}
            aria-controls="setpanel-{s.id}"
            onclick={() => (tab = s.id)}
          ><span class="g" aria-hidden="true">{s.glyph}</span><span class="nm">{s.label}</span></button>
        {/each}
        <span class="navsec">Elsewhere</span>
        {#each SECTIONS.filter((s) => s.group === 'out') as s (s.id)}
          <button
            role="tab"
            aria-selected={tab === s.id}
            aria-controls="setpanel-{s.id}"
            onclick={() => (tab = s.id)}
          ><span class="g" aria-hidden="true">{s.glyph}</span><span class="nm">{s.label}</span></button>
        {/each}
        <span class="navsec">Studio</span>
        {#each SECTIONS.filter((s) => s.group === 'app') as s (s.id)}
          <button
            role="tab"
            aria-selected={tab === s.id}
            aria-controls="setpanel-{s.id}"
            onclick={() => (tab = s.id)}
          ><span class="g" aria-hidden="true">{s.glyph}</span><span class="nm">{s.label}</span></button>
        {/each}
      </div>

      <div class="setpanel" id="setpanel-{tab}" role="tabpanel">
        {#if tab === 'repos'}
      <div class="setsec">
        <span class="lbl">Repo roots <span class="lbl-note">— folders scanned for your repos, in scan order</span></span>
        {#each rootRows as row, i (row.key)}
          <div
            class="srvcfg-row cols2"
            use:reorderable={{ index: i, onmove: (f, tIdx) => (rootRows = move(rootRows, f, tIdx)) }}
          >
            <span class="grip" title="Drag to reorder" aria-hidden="true">⠿</span>
            <input bind:value={row.path} placeholder="~/code" aria-label="Repo root" />
            <!-- Browsing beats typing here because the judgement is not "is this path
                 spelled right" but "does this folder CONTAIN repos" — which a text field
                 cannot answer and the picker states outright. -->
            <button
              class="btn ghost xs"
              title="Browse for a folder"
              aria-label="Browse for a folder"
              onclick={() => (picking = row.key)}
            >…</button>
            <button class="btn ghost xs" title="Move up" aria-label="Move up" disabled={i === 0} onclick={() => (rootRows = nudge(rootRows, i, -1))}>↑</button>
            <button class="btn ghost xs" title="Move down" aria-label="Move down" disabled={i === rootRows.length - 1} onclick={() => (rootRows = nudge(rootRows, i, 1))}>↓</button>
            <button class="btn ghost xs" title="Remove" aria-label="Remove" onclick={() => (rootRows = rootRows.filter((r) => r.key !== row.key))}>✕</button>
          </div>
        {/each}
        <button class="btn ghost xs add" onclick={() => (rootRows = [...rootRows, { key: ++rowKey, path: '' }])}>＋ add root</button>
      </div>

      {#if pickingRow}
        <!-- Opens where that row already points, so editing an existing root lands you in
             it rather than back at the home directory. -->
        <DirPicker
          start={pickingRow.path}
          onclose={() => (picking = null)}
          onpick={(p) => {
            const hit = rootRows.find((r) => r.key === picking);
            if (hit) hit.path = p;
            picking = null;
          }}
        />
      {/if}

      <div class="setsec">
        <span class="lbl">Feature groups <span class="lbl-note">— only for worktrees whose names do NOT match</span></span>
        <!-- Said out loud, because the word "group" does not carry it: a feature is
             normally AUTOMATIC — worktrees in different repos that share a name are one
             feature. A group is the manual override for when the names cannot match. -->
        <p class="secnote">
          Worktrees that share a name are already one feature — you need a group only when
          they differ, e.g. <code>api/fix-login</code> with <code>web/login-cleanup</code>.
        </p>
        {#each groupRows as row, i (row.key)}
          <div
            class="srvcfg-row cols3"
            use:reorderable={{ index: i, onmove: (f, tIdx) => (groupRows = move(groupRows, f, tIdx)) }}
          >
            <span class="grip" title="Drag to reorder" aria-hidden="true">⠿</span>
            <input bind:value={row.name} placeholder="group name…" aria-label="Group name" />
            <input bind:value={row.members} placeholder="repo/branch, repo/branch…" aria-label="Group members" />
            <button class="btn ghost xs" title="Remove" aria-label="Remove" onclick={() => (groupRows = groupRows.filter((r) => r.key !== row.key))}>✕</button>
          </div>
        {/each}
        <button class="btn ghost xs add" onclick={() => (groupRows = [...groupRows, { key: ++rowKey, name: '', members: '' }])}>＋ add group</button>
      </div>
        {:else if tab === 'servers'}
      <div class="setsec">
        <span class="lbl">Dev servers <span class="lbl-note">— per-repo launch command &amp; ports (space/comma separated)</span></span>
        {#each startRows as row, i (row.key)}
          <div
            class="srvcfg-row"
            use:reorderable={{ index: i, onmove: (f, tIdx) => (startRows = move(startRows, f, tIdx)) }}
          >
            <span class="grip" title="Drag to reorder" aria-hidden="true">⠿</span>
            <input list="setRepoList" bind:value={row.repo} placeholder="repo…" aria-label="Repo" />
            <input bind:value={row.cmd} placeholder="command…" aria-label="Command" />
            <input bind:value={row.ports} placeholder="ports" aria-label="Ports" />
            <button class="btn ghost xs" title="Remove" aria-label="Remove" onclick={() => (startRows = startRows.filter((r) => r.key !== row.key))}>✕</button>
          </div>
        {/each}
        <button class="btn ghost xs add" onclick={() => (startRows = [...startRows, { key: ++rowKey, repo: '', cmd: '', ports: '' }])}>＋ add server</button>
      </div>

      <!--
        Concurrency lives in this tab rather than a sixth one: a slot is a property of how
        dev servers get launched, and two fields do not earn their own section in the rail.
      -->
      <div class="setsec">
        <span class="lbl">Concurrency <span class="lbl-note">— running several features' servers at once</span></span>
        <p class="secnote">
          Each feature gets a <b>slot</b>; slot <i>n</i> offsets every dev-server port by
          <i>n</i>×100 and sets per-slot values like <code>redis__db</code>. Slot 0 is the
          base ports. Pick a slot explicitly from the caret beside <b>▶</b>, or move a
          running feature from its slot badge.
        </p>

        <label class="fieldrow">
          <span class="fieldlbl">Max slots</span>
          <input
            class="num"
            type="number"
            min="1"
            max="16"
            bind:value={conc.maxSlots}
            aria-label="Maximum concurrency slots"
          />
          <span class="lbl-note">how many features may run dev servers at once</span>
        </label>

        <fieldset class="radios">
          <legend class="fieldlbl">When no slot is chosen</legend>
          <label>
            <input type="radio" bind:group={conc.slotPolicy} value="lowest" />
            <span>
              <b>Lowest free slot</b>
              <span class="lbl-note">— ignores what is listening; a slot is free if no feature holds it.</span>
            </span>
          </label>
          <label>
            <input type="radio" bind:group={conc.slotPolicy} value="free-ports" />
            <span>
              <b>Lowest slot whose ports are actually free</b>
              <span class="lbl-note">— skips a slot some untracked process is sitting on, instead of failing at launch.</span>
            </span>
          </label>
        </fieldset>
      </div>

      <div class="setsec">
        <span class="lbl">Run configurations <span class="lbl-note">— hand-written; your editor's own are found automatically</span></span>
        <p class="secnote">
          <b>▷ Run</b> reads <code>.idea/runConfigurations</code>, <code>.vscode</code> and
          <code>.zed</code> from each worktree, so anything your editor already knows needs
          no entry here. Add one only for a command no editor config expresses.
          <b>server</b> is tracked like a dev server; <b>task</b> gets a run with output and
          an exit code.
        </p>
        {#each runRows as row, i (row.key)}
          <div
            class="srvcfg-row cols4"
            use:reorderable={{ index: i, onmove: (f, tIdx) => (runRows = move(runRows, f, tIdx)) }}
          >
            <span class="grip" title="Drag to reorder" aria-hidden="true">⠿</span>
            <input list="setRepoList" bind:value={row.repo} placeholder="repo…" aria-label="Repo" />
            <input bind:value={row.name} placeholder="name…" aria-label="Run configuration name" />
            <input bind:value={row.cmd} placeholder="command…" aria-label="Command" />
            <select class="mini-select" bind:value={row.kind} aria-label="Kind">
              <option value="task">task</option>
              <option value="server">server</option>
            </select>
            <button class="btn ghost xs" title="Remove" aria-label="Remove" onclick={() => (runRows = runRows.filter((r) => r.key !== row.key))}>✕</button>
          </div>
        {/each}
        <button class="btn ghost xs add" onclick={() => (runRows = [...runRows, { key: ++rowKey, repo: '', name: '', cmd: '', kind: 'task' }])}>＋ add run configuration</button>
      </div>

        {:else if tab === 'editors'}
      <div class="setsec">
        <span class="lbl">Editors <span class="lbl-note">— <code>{'{path}'}</code> is the worktree path</span></span>
        {#each editorRows as row, i (row.key)}
          <div
            class="srvcfg-row cols3"
            use:reorderable={{ index: i, onmove: (f, tIdx) => (editorRows = move(editorRows, f, tIdx)) }}
          >
            <span class="grip" title="Drag to reorder" aria-hidden="true">⠿</span>
            <input bind:value={row.name} placeholder="name…" aria-label="Editor name" />
            <input bind:value={row.open} placeholder="open command with {'{path}'}…" aria-label="Open command" />
            <button class="btn ghost xs" title="Remove" aria-label="Remove" onclick={() => (editorRows = editorRows.filter((r) => r.key !== row.key))}>✕</button>
          </div>
        {/each}
        <button class="btn ghost xs add" onclick={() => (editorRows = [...editorRows, { key: ++rowKey, name: '', open: '', openGroup: '' }])}>＋ add editor</button>

        <!-- Which editor "Open in editor" actually uses. The server has always accepted
             `defaultEditor` and returned it; this modal never sent it and offered no
             control, so the choice was stuck at whatever config.json said and could only
             be changed by hand-editing the file and restarting the daemon. -->
        <label class="picker">
          <span>Open in editor uses</span>
          <select class="mini-select" bind:value={defaultEditor} aria-label="Default editor">
            {#each editorRows.filter((r) => r.name.trim()) as r (r.key)}
              <option value={r.name.trim()}>{r.name.trim()}</option>
            {/each}
          </select>
        </label>
      </div>

        {:else if tab === 'conn'}
      <div class="field">
        <span class="lbl">Asana <span class="lbl-note">— where your tasks come from</span></span>
        <!--
          THREE STEPS, drawn as three steps.
          A token box, a Connect button, a workspace dropdown and a "Use this" button used
          to share two cramped rows while the state changed underneath — so it read as one
          crowded thing rather than a sequence with a beginning and an end.
        -->
        {#if as.enabled && as.token && as.workspace}
          <div class="conn">
            <span class="ok">✓ connected</span>
            <span class="conn-what">{asanaWho || 'Asana'}{asanaWorkspaceName ? ` · ${asanaWorkspaceName}` : ''}</span>
            <button class="btn ghost xs" onclick={disconnectAsana}>Disconnect</button>
          </div>
          <span class="hint">
            Your assigned tasks appear when you link a feature to a task, and each ticket chip
            shows where it sits on the board.
          </span>
        {:else}
          <ol class="steps">
            <li class="step" class:done={asanaWho} class:now={!asanaWho}>
              <span class="n" aria-hidden="true">{asanaWho ? '✓' : '1'}</span>
              <div class="sbody">
                {#if asanaWho}
                  <span class="t">Connected as {asanaWho}</span>
                {:else}
                  <span class="t">Paste a personal access token</span>
                  <input
                    class="input"
                    type="password"
                    placeholder="Personal access token"
                    bind:value={as.token}
                    aria-label="Asana token"
                  />
                  <span class="hint">
                    app.asana.com → your photo → My settings → Apps → Personal access tokens
                  </span>
                  <button
                    class="btn xs primary"
                    disabled={!as.token.trim() || asanaLoading}
                    onclick={connectAsana}
                  >{asanaLoading ? 'Checking…' : 'Connect'}</button>
                {/if}
              </div>
            </li>

            <li class="step" class:now={asanaWho} class:todo={!asanaWho}>
              <span class="n" aria-hidden="true">2</span>
              <div class="sbody">
                <span class="t">Choose a workspace</span>
                {#if !asanaWho}
                  <span class="hint">Studio will list the ones your token can see.</span>
                {:else if asanaWorkspaces.length > 1}
                  <!--
                    RADIO ROWS, not a dropdown. This account has two workspaces both named
                    "accept.blue" — one with 28 tasks assigned and one with none — and a
                    <select> hides the count until you open it, which is exactly how the
                    empty one came to be chosen.
                  -->
                  <span class="hint">The count is how you tell same-named workspaces apart.</span>
                  <div class="wslist" role="radiogroup" aria-label="Asana workspace">
                    {#each asanaWorkspaces as w (w.gid)}
                      <button
                        type="button"
                        class="ws"
                        role="radio"
                        aria-checked={as.workspace === w.gid}
                        onclick={() => (as.workspace = w.gid)}
                      >
                        <span class="radio" aria-hidden="true"></span>
                        <span class="nm">{w.name}</span>
                        <span class="ct">
                          {w.tasks < 0
                            ? ''
                            : w.tasks === 0
                              ? 'no tasks'
                              : `${w.tasks} task${w.tasks === 1 ? '' : 's'} assigned to you`}
                        </span>
                      </button>
                    {/each}
                  </div>
                  <button
                    class="btn xs primary"
                    disabled={!as.workspace}
                    onclick={() => (as.enabled = true)}
                  >Use this workspace</button>
                {/if}
              </div>
            </li>

            <li class="step todo">
              <span class="n" aria-hidden="true">3</span>
              <div class="sbody">
                <span class="t">Done</span>
                <span class="hint">Your tasks appear in the picker and on feature cards.</span>
              </div>
            </li>
          </ol>
          {#if asanaError}<span class="hint err">{asanaError}</span>{/if}
        {/if}
      </div>

      <div class="field">
        <span class="lbl">GitLab <span class="lbl-note">{tools.glab ? '— the glab CLI is available; a token is only needed for API mode' : '— API token'}</span></span>
        {#if gl.enabled && gl.token}
          <div class="conn"><span class="ok">✓ connected</span><span class="conn-what">{gl.host || 'gitlab.com'}{gl.project ? ` · ${gl.project}` : ''}</span>
            <button class="btn ghost xs" onclick={() => { gl.enabled = false; gl.token = ''; }}>Disconnect</button>
          </div>
        {:else}
          <div class="conn-row">
            <input class="input" placeholder="https://gitlab.com" bind:value={gl.host} aria-label="GitLab host" />
            <input class="input" placeholder="group/project (API mode)" bind:value={gl.project} aria-label="GitLab project" />
          </div>
          <div class="conn-row">
            <input class="input" type="password" placeholder="Personal access token" bind:value={gl.token} aria-label="GitLab token" />
            <button class="btn xs" disabled={!gl.token.trim()} onclick={() => (gl.enabled = true)}>Connect</button>
          </div>
        {/if}
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

      <!--
        A CONNECTION, not three fields and a checkbox.
        Filling in a token IS the statement "I want this connected" — but `enabled` was a
        separate tick, so credentials could be saved, correct, and inert, with nothing on
        screen saying so. That is exactly what happened: a valid token and workspace sat
        beside `enabled: false` and the picker went on asking GitHub.

        So there is no checkbox. Connect proves the token works, says WHO it belongs to —
        a tick proves a request succeeded, a name proves it succeeded as you, which is what
        "assigned to me" actually rests on — and enables the source. Disconnect is the off
        switch, and it is unambiguous.
      -->
        {:else if tab === 'notify'}
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

        {/if}
      </div>
    {/if}
  </div>

  <div class="modal-foot">
    <span class="foot-note">Saved to ~/.config/worktree-studio/config.json</span>
    <span class="spacer"></span>
    <button class="btn" onclick={tryClose}>Close</button>
    <button class="btn primary" disabled={!loaded || saving} onclick={save}>{saving ? 'Saving…' : 'Save'}</button>
  </div>
</Modal>

<style>
  .modal-head { display:flex; align-items:center; gap:9px; padding:14px 16px; border-bottom:1px solid var(--border); font-size:15px; }
  /* Sidebar + panel. min-height keeps the modal from resizing as you switch between a
     long panel and a short one, which reads as the dialog jumping under the cursor. */
  .setwrap { display:flex; min-height:340px; max-height:70vh; }
  .setnav { width:160px; flex:none; border-right:1px solid var(--border); background:var(--elevated);
            padding:8px; overflow-y:auto; }
  .setnav button { display:flex; align-items:center; gap:9px; width:100%; font:inherit; font-size:13px;
                   background:none; border:0; border-radius:7px; color:var(--muted); padding:8px 9px;
                   cursor:pointer; text-align:left; }
  .setnav button:hover { background:var(--panel); color:var(--ink); }
  .setnav button[aria-selected='true'] { background:var(--panel); color:var(--ink); font-weight:600;
                                         box-shadow:inset 2px 0 0 var(--brand); }
  .setnav .g { width:15px; text-align:center; color:var(--faint); font-family:var(--mono); font-size:12px; }
  .setnav button[aria-selected='true'] .g { color:var(--brand); }
  .navsec { display:block; font-family:var(--mono); font-size:9.5px; letter-spacing:.11em;
            text-transform:uppercase; color:var(--faint); padding:11px 9px 5px; }
  .setpanel { flex:1; min-width:0; overflow-y:auto; padding:16px; display:flex;
              flex-direction:column; gap:18px; }
  /* Under ~700px the modal is already at 96vw, so the labels go and the glyphs carry it. */
  @media (max-width:700px) {
    .setnav { width:46px; }
    .setnav .nm, .navsec { display:none; }
    .setnav button { justify-content:center; padding:9px 0; }
  }

  .modal-foot { display:flex; align-items:center; gap:10px; padding:13px 16px; border-top:1px solid var(--border); }
  .foot-note { font-family:var(--mono); font-size:12px; color:var(--faint); }
  .field { display:flex; flex-direction:column; gap:6px; }
  .field label, .field .lbl { font-family:var(--mono); font-size:11.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--faint); display:flex; align-items:center; gap:8px; }
  .hint, .lbl-note { text-transform:none; letter-spacing:0; color:var(--faint); }
  .chk { display:inline-flex; align-items:center; gap:6px; font-family:var(--mono); font-size:12px; color:var(--muted); text-transform:none; letter-spacing:0; }
  .chk input { accent-color:var(--brand); }
  .conn-status { font-family:var(--mono); font-size:13px; color:var(--muted); }
  .conn-status .ok { color:var(--done); }
  .conn-status .warn { color:var(--waiting); }
  .setsec { display:flex; flex-direction:column; gap:9px; }
  .setsec > .lbl { font-family:var(--mono); font-size:11.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--faint); display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .setsec .add { align-self:flex-start; }
  /* A leading grip column on every row, so the lists line up with each other. */
  .srvcfg-row { display:grid; grid-template-columns:18px 120px 1fr 90px 30px; gap:8px; align-items:center; }
  .srvcfg-row.cols3 { grid-template-columns:18px 120px 1fr 30px; }
  /* Repo roots: one field, then move-up / move-down / remove. */
  .srvcfg-row.cols2 { grid-template-columns:18px 1fr 28px 28px 30px; }
  .srvcfg-row.cols4 { grid-template-columns:18px 110px 130px 1fr 84px 30px; }

  .grip { cursor:grab; color:var(--faint); font-size:14px; line-height:1; text-align:center; user-select:none; }
  .grip:active { cursor:grabbing; }
  /* Set by the reorderable action while a drag is in flight. */
  .srvcfg-row:global(.dragging) { opacity:.45; }
  .srvcfg-row:global(.dragover) { box-shadow:inset 0 2px 0 var(--brand); }

  .picker { display:flex; align-items:center; gap:9px; margin-top:4px; font-family:var(--mono); font-size:12px; color:var(--muted); }
  .secnote { margin:0 0 4px; font-size:12.5px; line-height:1.5; color:var(--muted); }
  .secnote code { font-family:var(--mono); font-size:11.5px; }

  /* ---- concurrency ---- */
  .fieldrow { display:flex; align-items:center; gap:10px; font-size:13px; }
  .fieldlbl { font-size:12px; font-weight:600; color:var(--muted); }
  .num {
    width:66px; font-family:var(--mono); font-variant-numeric:tabular-nums;
    font-size:13px; padding:5px 8px; border-radius:7px;
    border:1px solid var(--border-strong); background:var(--elevated); color:var(--ink);
  }
  .radios { border:0; margin:6px 0 0; padding:0; display:flex; flex-direction:column; gap:8px; }
  .radios legend { padding:0; margin-bottom:2px; }
  .radios label { display:flex; align-items:flex-start; gap:8px; font-size:13px; cursor:pointer; }
  .radios label input { margin-top:3px; }
  .radios label span { display:block; }
  .srvcfg-row input { background:var(--panel); border:1px solid var(--border-strong); border-radius:7px; padding:6px 9px; color:var(--ink); font-family:var(--mono); font-size:12.5px; width:100%; }
</style>
