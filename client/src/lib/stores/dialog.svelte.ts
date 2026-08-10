/*
 * Promise-returning dialogs — the port of app.js's uiDialog / uiConfirm / uiPrompt.
 *
 * Native alert/confirm/prompt are deliberately not used: they block the event loop
 * (which stalls the SSE stream and every live terminal), can't be styled, and can't be
 * focus-trapped. The API is unchanged, so call sites read the same as before:
 *
 *   if (!(await uiConfirm('Delete?', { danger: true }))) return;
 *   const name = await uiPrompt('Rename session:', s.title);
 *
 * `DialogHost.svelte` renders whatever is queued here; a dialog opened from inside
 * another dialog's handler queues behind it rather than stacking two backdrops.
 */

/** A pinned link row, as the `links` field carries it. */
export interface DialogLink {
  label?: string;
  url: string;
  /**
   * Identity for `{#each}`, assigned when the dialog seeds its rows.
   *
   * Rows are DRAGGABLE, so keying on the index would recycle the wrong inputs the moment
   * two rows swap: Svelte would keep the DOM in place and rewrite the values, which puts
   * the caret and any selection on the row you did not touch. Stripped on save — it is a
   * rendering concern and has no business on disk.
   */
  key?: number;
}

/** text/select carry a string, a checkbox a boolean, `links` a list of rows. */
export type DialogValue = string | boolean | DialogLink[];

/**
 * What `open()` settles to: null on cancel/Escape, true when the dialog had no
 * fields, otherwise the field values in declaration order.
 */
export type DialogResult = null | true | DialogValue[];

export interface DialogField {
  /**
   * `color` renders the feature-colour swatches. It is a field type rather than its own
   * dialog because picking a colour is never the whole errand — you open the editor to
   * change a name and tag it in one pass, and two dialogs for one edit is two dismissals.
   */
  type?: 'text' | 'checkbox' | 'select' | 'color' | 'links';
  label?: string;
  value?: DialogValue;
  placeholder?: string;
  options?: string[];
  /**
   * Turn a text field into "pick one, or type your own".
   *
   * The dialog fetches the candidates itself, so a caller does not have to load them
   * before it can open. The TEXT FIELD STAYS: every tracker token is user-scoped, so the
   * list is "assigned to me" — and a task nobody assigned to you, or one in a tracker
   * with no adapter, must still be pasteable. A picker that replaced the field would make
   * the common case easier and the uncommon one impossible.
   */
  pick?: { source: 'tasks'; placeholder?: string };
  /**
   * Read-only lines shown above a `links` field's editable rows.
   *
   * For links that are DERIVED — the ticket from intake, the merge requests from the
   * forge. They belong in the same place as the pinned ones because the user thinks of
   * them as one set, but they are recomputed on every poll, so offering to edit them
   * would be offering something that cannot be honoured.
   */
  derived?: string[];
}

export interface DialogSpec {
  title?: string;
  message?: string;
  messageHtml?: string;
  fields?: DialogField[];
  okLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface QueuedDialog {
  id: number;
  spec: DialogSpec;
  resolve: (v: DialogResult) => void;
}

let nextId = 0;

class Dialogs {
  queue = $state<QueuedDialog[]>([]);

  /** The dialog currently on screen — the head of the queue. */
  current = $derived(this.queue[0] || null);

  open(spec: DialogSpec): Promise<DialogResult> {
    return new Promise((resolve) => {
      const id = ++nextId;
      this.queue = [...this.queue, { id, spec, resolve }];
    });
  }

  close(id: number, value: DialogResult): void {
    const entry = this.queue.find((q) => q.id === id);
    if (!entry) return;
    this.queue = this.queue.filter((q) => q.id !== id);
    entry.resolve(value);
  }

  /** True while any dialog is up — the global shortcut handler checks this. */
  get open_(): boolean {
    return this.queue.length > 0;
  }
}

export const dialogs = new Dialogs();

export const uiDialog = (spec: DialogSpec): Promise<DialogResult> => dialogs.open(spec);

export async function uiConfirm(
  message: string,
  opts: { title?: string; okLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  const r = await dialogs.open({
    title: opts.title || 'Confirm',
    message,
    okLabel: opts.okLabel || 'OK',
    danger: opts.danger,
  });
  return r === true;
}

export async function uiPrompt(
  message: string,
  value = '',
  opts: { label?: string; placeholder?: string; okLabel?: string } = {},
): Promise<string | null> {
  const r = await dialogs.open({
    title: message,
    fields: [{ type: 'text', label: opts.label || '', value, placeholder: opts.placeholder || '' }],
    okLabel: opts.okLabel || 'OK',
  });
  return Array.isArray(r) ? String(r[0] ?? '') : null;
}
