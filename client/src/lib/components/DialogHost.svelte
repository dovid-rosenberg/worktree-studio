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
  import { dialogs } from '$lib/stores/dialog.svelte.js';

  const entry = $derived(dialogs.current);
  const spec = $derived(entry?.spec ?? null);
  const fields = $derived(spec?.fields ?? []);

  /** Field values, re-seeded whenever a different dialog reaches the head of the queue. */
  let values = $state<any[]>([]);
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
  .field label { font-family:var(--mono); font-size:11.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--faint); display:flex; align-items:center; gap:8px; }
  /* The shortcuts cheatsheet is a messageHtml payload, so its rules live here. */
  .dlg-msg :global(.kbd-list) { display:flex; flex-direction:column; gap:8px; }
  .dlg-msg :global(.kbd-row) { display:flex; align-items:center; gap:12px; font-size:14px; }
  .dlg-msg :global(.kbd-row kbd) { flex:none; min-width:56px; text-align:center; font-family:var(--mono); font-size:12.5px; color:var(--ink); background:var(--elevated); border:1px solid var(--border-strong); border-radius:6px; padding:3px 8px; }
  .dlg-msg :global(.kbd-row span) { color:var(--muted); }
</style>
