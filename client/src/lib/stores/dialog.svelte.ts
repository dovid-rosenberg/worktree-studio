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

/** A field's value: text/select carry a string, a checkbox carries a boolean. */
export type DialogValue = string | boolean;

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
  type?: 'text' | 'checkbox' | 'select' | 'color';
  label?: string;
  value?: DialogValue;
  placeholder?: string;
  options?: string[];
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
