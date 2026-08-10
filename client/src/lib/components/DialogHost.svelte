<script lang="ts">
  /*
   * Renders the queued uiDialog/uiConfirm/uiPrompt (see stores/dialog.svelte.js).
   *
   * Enter submits unless the dialog contains a <select> — a select swallows Enter for
   * its own option choice, and app.js made the same exception. Escape resolves null;
   * it is handled here rather than globally because a dialog outranks every other
   * overlay and can be opened from inside one.
   */
  import Modal from '$lib/components/Modal.svelte';
  import { COLOR_LABELS, FEATURE_COLORS, colorVars } from '$lib/featureColor.js';
  import { dialogs } from '$lib/stores/dialog.svelte.js';
  import type { DialogLink } from '$lib/stores/dialog.svelte.js';
  import { moveItem, reorderable } from '$lib/actions/reorderable.js';
  import { api } from '$lib/api.js';
  import { errMessage } from '$lib/errmsg.js';

  const entry = $derived(dialogs.current);
  const spec = $derived(entry?.spec ?? null);
  const fields = $derived(spec?.fields ?? []);

  /** Field values, re-seeded whenever a different dialog reaches the head of the queue. */
  let values = $state<any[]>([]);
  /** Monotonic row identity for the `links` field — see DialogLink.key. */
  let linkKey = 0;

  /*
   * Assigned tasks for a `pick` field, fetched when a dialog that wants them opens.
   *
   * Here rather than in the caller so opening the editor never waits on a tracker: the
   * field renders immediately and the options fill in. A failure is silent — the text
   * field is still there, which is the whole point of keeping it.
   */
  let tasks = $state<Array<{ title: string; subtitle: string; url: string }>>([]);
  let tasksLoading = $state(false);
  /**
   * Why the list is empty, when it is.
   *
   * An empty dropdown with no explanation is the worst of both: it looks broken, and the
   * actual cause — no tracker configured — is a setting the user can fix in a minute.
   * The first version of this simply rendered nothing.
   */
  let tasksNote = $state('');

  $effect(() => {
    if (!fields.some((f) => f.pick)) return;
    let alive = true;
    tasksLoading = true;
    tasksNote = '';
    (async () => {
      try {
        const srcs: Array<{ id: string; label: string; needsRepo?: boolean }> =
          (await api('GET', '/api/v1/sources')) || [];
        // `freetext` is the "just type it" source and has no tasks to list.
        const trackers = srcs.filter((s) => s.id !== 'freetext');
        if (!trackers.length) {
          if (alive) tasksNote = 'No task tracker connected — add one in Settings';
          return;
        }
        /*
         * A source with `needsRepo` lists issues FROM a repo, so it needs one to ask
         * about — and only the repos this feature actually spans. Omitting it entirely
         * made every such source answer with nothing; fanning out over every repo you own
         * made it twelve subprocesses for one dropdown.
         */
        const repos = fields.find((f) => f.pick)?.pick?.repos || [];
        const all: Array<{ title: string; subtitle: string; url: string }> = [];
        for (const s of trackers) {
          // A repo-scoped source with no repo to ask about is skipped, not guessed at.
          const targets = s.needsRepo ? repos : [''];
          if (!targets.length) continue;
          for (const repo of targets) {
            const q = repo ? `?repo=${encodeURIComponent(repo)}` : '';
            const r = await api('GET', `/api/v1/sources/${encodeURIComponent(s.id)}/items${q}`);
            for (const it of r.items || []) if (it.url) all.push(it);
          }
        }
        if (!alive) return;
        tasks = all;
        if (!all.length) {
          tasksNote = `Nothing assigned to you in ${trackers.map((s) => s.label).join(', ')}`;
        }
      } catch (e) {
        // Named, not swallowed: a bad token is a fixable thing and the commonest cause.
        if (alive) tasksNote = `Could not load tasks — ${errMessage(e)}`;
      } finally {
        if (alive) tasksLoading = false;
      }
    })();
    return () => {
      alive = false;
    };
  });

  /** Keyboard equivalent of a drag, as SettingsModal does it: dragging serves a mouse only. */
  function nudge(i: number, rows: DialogLink[], by: number): DialogLink[] {
    return moveItem(rows, i, Math.max(0, Math.min(rows.length - 1, i + by)));
  }
  let root = $state<HTMLElement|null>(null);

  $effect(() => {
    const id = entry?.id;
    if (id == null) return;
    values = fields.map((f) => (f.type === 'checkbox' ? !!f.value : (f.value ?? '')));
    // Focus the first field, else the confirm button — the same target app.js chose.
    // The nodes only exist after this render, so defer by a microtask.
    queueMicrotask(() => {
      const el = /** @type {HTMLElement|null} */ (root?.querySelector<HTMLElement>('.dlgf') || root?.querySelector<HTMLElement>('.dlg-ok'));
      el?.focus();
      if (el instanceof HTMLInputElement && el.type !== 'checkbox') el.select();
    });
  });

  function submit() {
    if (!entry) return;
    dialogs.close(entry.id, fields.length ? [...values] : true);
  }
  function cancel() {
    if (!entry) return;
    dialogs.close(entry.id, null);
  }

  /** @param {KeyboardEvent} e */
  function onKeydown(e: KeyboardEvent) {
    if (!entry) return;
    if (e.key === 'Escape') { e.stopPropagation(); cancel(); return; }
    if (e.key !== 'Enter') return;
    if (fields.some((f) => f.type === 'select')) return;
    if (e.target instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    submit();
  }
</script>

{#if entry && spec}
  <!-- Keyed on the dialog id: a queued dialog reaching the head gets a fresh panel and
       a fresh focus trap rather than inheriting the previous one's. -->
  {#key entry.id}
    <Modal panelClass="dlg" label={spec.title || 'Dialog'} onclose={cancel}>
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div class="dlg-inner" role="document" onkeydown={onKeydown} bind:this={root}>
        <div class="modal-head"><b>{spec.title || ''}</b><span class="spacer"></span></div>
        <div class="modal-body">
          {#if spec.messageHtml}
            <!-- Built by ops.js from escaped server values (PR URLs, error strings) and
                 by showShortcuts() from a literal table. Nothing user-typed reaches it. -->
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            <div class="dlg-msg">{@html spec.messageHtml}</div>
          {:else if spec.message}
            <div class="dlg-msg">{spec.message}</div>
          {/if}

          {#each fields as f, i (i)}
            {#if f.type === 'checkbox'}
              <label class="dlg-check">
                <input class="dlgf" type="checkbox" bind:checked={values[i]} /> {f.label || ''}
              </label>
            {:else if f.type === 'links'}
              <div class="field">
                <span class="lbl">{f.label || ''}</span>
                {#each f.derived || [] as d (d)}
                  <!-- Shown but not editable: these come from intake and the forge and are
                       recomputed every poll, so an editable field would be a lie. -->
                  <div class="derived"><span>{d}</span></div>
                {/each}
                <!-- Order is what the dock header renders, so this list IS the display
                     order — not a preference about it. Same affordances as the settings
                     modal's five lists: a grip to drag, ↑/↓ for anyone not using a mouse. -->
                {#each values[i] as DialogLink[] as row, r (row.key)}
                  <div
                    class="linkrow"
                    use:reorderable={{
                      index: r,
                      onmove: (from, to) => { values[i] = moveItem(values[i] as DialogLink[], from, to); },
                    }}
                  >
                    <span class="grip" title="Drag to reorder" aria-hidden="true">⠿</span>
                    <input class="input lbl-in" placeholder="Label" bind:value={row.label} />
                    <input class="input" placeholder="https://…" bind:value={row.url} />
                    <button
                      class="btn xs ghost"
                      type="button"
                      title="Move up"
                      aria-label="Move link up"
                      disabled={r === 0}
                      onclick={() => { values[i] = nudge(r, values[i] as DialogLink[], -1); }}
                    >↑</button>
                    <button
                      class="btn xs ghost"
                      type="button"
                      title="Move down"
                      aria-label="Move link down"
                      disabled={r === (values[i] as DialogLink[]).length - 1}
                      onclick={() => { values[i] = nudge(r, values[i] as DialogLink[], 1); }}
                    >↓</button>
                    <button
                      class="btn xs ghost"
                      type="button"
                      aria-label="Remove link"
                      title="Remove"
                      onclick={() => { values[i] = (values[i] as DialogLink[]).filter((x: DialogLink) => x.key !== row.key); }}
                    >✕</button>
                  </div>
                {/each}
                <div class="linkrow addrow">
                  <input
                    class="input"
                    placeholder="Paste a URL to add — anything works"
                    onchange={(e) => {
                      const el = e.currentTarget;
                      const url = el.value.trim();
                      if (!url) return;
                      values[i] = [...(values[i] as DialogLink[]), { label: '', url, key: ++linkKey }];
                      el.value = '';
                    }}
                  />
                </div>
              </div>
            {:else if f.type === 'color'}
              <div class="field">
                <span class="lbl">{f.label || ''}</span>
                <!-- A radio GROUP, not buttons: arrow keys move between swatches and the
                     selected one is announced, which a row of divs would not be. -->
                <div class="swatches" role="radiogroup" aria-label={f.label || 'Colour'}>
                  <label class="sw none" class:on={!values[i]} title="No colour">
                    <input type="radio" value="" bind:group={values[i]} />
                    <span class="chip" aria-hidden="true">✕</span>
                    <span class="vh">None</span>
                  </label>
                  {#each FEATURE_COLORS as c (c)}
                    <label class="sw" class:on={values[i] === c} title={COLOR_LABELS[c] || c} style={colorVars(c)}>
                      <input type="radio" value={c} bind:group={values[i]} />
                      <span class="chip tint" aria-hidden="true"></span>
                      <span class="vh">{COLOR_LABELS[c] || c}</span>
                    </label>
                  {/each}
                </div>
              </div>
            {:else if f.type === 'select'}
              <div class="field">
                <label for="dlgf-{i}">{f.label || ''}</label>
                <select id="dlgf-{i}" class="select dlgf" bind:value={values[i]}>
                  {#each f.options || [] as o (o)}<option value={o}>{o}</option>{/each}
                </select>
              </div>
            {:else}
              <div class="field">
                <label for="dlgf-{i}">{f.label || ''}</label>
                {#if f.pick}
                  {@const chosen = tasks.find((t) => t.url === values[i])}
                  {#if chosen}
                    <!--
                      SHOW WHAT WAS PICKED.
                      The select used to reset itself to the placeholder on change, so the
                      only evidence of choosing a task was a long URL appearing in a
                      different box — i.e. picking a task looked like nothing happening. The
                      task now stays on screen, named; the URL is a detail, not the receipt.
                    -->
                    <div class="picked">
                      <span class="pg" aria-hidden="true">◎</span>
                      <span class="pnm">{chosen.title}</span>
                      <button
                        class="btn xs ghost"
                        type="button"
                        title="Choose a different task"
                        aria-label="Clear the chosen task"
                        onclick={() => (values[i] = '')}
                      >✕</button>
                    </div>
                  {:else}
                    <!-- Pick one, or type your own. The list is what the tracker says is
                         assigned to you; the field below it is how anything else gets in. -->
                    <select
                      class="select"
                      aria-label="Pick a task"
                      onchange={(e) => {
                        const v = e.currentTarget.value;
                        if (v) values[i] = v;
                      }}
                    >
                      <option value="">{tasksLoading ? 'Loading…' : tasksNote || f.pick.placeholder || 'Pick…'}</option>
                      {#each tasks as t (t.url)}<option value={t.url}>{t.title}{t.subtitle ? ` · ${t.subtitle}` : ''}</option>{/each}
                    </select>
                  {/if}
                {/if}
                <!-- Kept even when a task is chosen: it is the URL that gets saved, and a
                     pasted link from a tracker with no adapter has nowhere else to go. -->
                <input id="dlgf-{i}" class="input dlgf" bind:value={values[i]} placeholder={f.placeholder || ''} />
              </div>
            {/if}
          {/each}
        </div>
        <div class="modal-foot">
          <span class="spacer"></span>
          {#if spec.cancelLabel !== ''}
            <button class="btn" onclick={cancel}>{spec.cancelLabel || 'Cancel'}</button>
          {/if}
          <button class="btn dlg-ok" class:danger={spec.danger} class:primary={!spec.danger} onclick={submit}>
            {spec.okLabel || 'OK'}
          </button>
        </div>
      </div>
    </Modal>
  {/key}
{/if}

<style>
  .dlg-inner { display:flex; flex-direction:column; min-height:0; }
  .modal-head { display:flex; align-items:center; gap:9px; padding:14px 16px; border-bottom:1px solid var(--border); font-size:15px; }
  .modal-body { padding:16px; background:var(--elevated); border-top:1px solid var(--border); display:flex; flex-direction:column; gap:14px; overflow-y:auto; }
  .modal-foot { display:flex; align-items:center; gap:10px; padding:13px 16px; border-top:1px solid var(--border); }
  .dlg-msg { font-size:15px; line-height:1.55; color:var(--ink); }
  .dlg-msg :global(a.link) { word-break:break-all; }
  .dlg-check { display:flex; align-items:center; gap:8px; font-size:14.5px; }
  .dlg-check input { accent-color:var(--brand); }
  .field { display:flex; flex-direction:column; gap:6px; }
  /* The swatch labels are `.lbl`, not `label`: the rule below styles `.field label` as a
     caption, and every swatch IS a label wrapping its radio. */
  .lbl { font-family:var(--mono); font-size:11.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--faint); }
  /* A grip column first, so the rows line up with the settings modal's lists. */
  /* The chosen task, named. Brand-tinted because it is a choice you made, not a status. */
  .picked { display:flex; align-items:center; gap:9px; padding:7px 10px; border:1px solid var(--brand);
            border-radius:8px; background:var(--brand-soft); }
  .picked .pg { color:var(--brand); flex:none; }
  .picked .pnm { flex:1; min-width:0; font-size:13.5px; overflow:hidden; text-overflow:ellipsis;
                 white-space:nowrap; }
  .linkrow { display:grid; grid-template-columns:18px 120px 1fr 26px 26px 28px; gap:8px; align-items:center; }
  /* The add row has no grip and nothing to move: one field across the whole width. */
  .linkrow.addrow { grid-template-columns:1fr; }
  .linkrow .input { min-width:0; }
  .grip { cursor:grab; color:var(--faint); font-size:14px; line-height:1; text-align:center; user-select:none; }
  .grip:active { cursor:grabbing; }
  /* Set by the reorderable action while a drag is in flight. */
  .linkrow:global(.dragging) { opacity:.45; }
  .linkrow:global(.dragover) { box-shadow:inset 0 2px 0 var(--brand); }
  .derived { display:flex; align-items:center; gap:8px; font-family:var(--mono); font-size:11.5px;
             color:var(--faint); padding:6px 9px; border:1px dashed var(--border); border-radius:7px; }
  .swatches { display:flex; flex-wrap:wrap; gap:8px; }
  .sw { position:relative; cursor:pointer; border-radius:8px; padding:3px; border:2px solid transparent; line-height:0; }
  .sw:hover { border-color:var(--border-strong); }
  .sw.on { border-color:var(--fc, var(--brand)); }
  /* Visually hidden but focusable — the ring lands on the swatch via :focus-within. */
  .sw input { position:absolute; opacity:0; width:0; height:0; }
  .sw:focus-within { outline:2px solid var(--brand); outline-offset:2px; }
  .chip { display:block; width:26px; height:26px; border-radius:6px; border:1px solid var(--border-strong); }
  /* Wash inside, accent as the rim — the same two-value split the cards use, so the
     swatch is a genuine preview of what the feature will look like. */
  .chip.tint { background:var(--fc-wash); border-color:var(--fc); }
  .sw.none .chip { display:flex; align-items:center; justify-content:center; line-height:1;
                   color:var(--faint); font-size:13px; background:var(--panel); }
  .vh { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
  .field label { font-family:var(--mono); font-size:11.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--faint); display:flex; align-items:center; gap:8px; }
  /* The shortcuts cheatsheet is a messageHtml payload, so its rules live here. */
  .dlg-msg :global(.kbd-list) { display:flex; flex-direction:column; gap:8px; }
  .dlg-msg :global(.kbd-row) { display:flex; align-items:center; gap:12px; font-size:14px; }
  .dlg-msg :global(.kbd-row kbd) { flex:none; min-width:56px; text-align:center; font-family:var(--mono); font-size:12.5px; color:var(--ink); background:var(--elevated); border:1px solid var(--border-strong); border-radius:6px; padding:3px 8px; }
  .dlg-msg :global(.kbd-row span) { color:var(--muted); }
</style>
