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

export interface DialogField {
  type?: 'text' | 'checkbox' | 'select';
  label?: string;
  value?: any;
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
  resolve: (v: any) => void;
}

let nextId = 0;

class Dialogs {
  queue = $state<QueuedDialog[]>([]);

  /** The dialog currently on screen — the head of the queue. */
  current = $derived(this.queue[0] || null);

  /**
   * Resolves `null` on cancel/Escape; `true` when there are no fields; otherwise an
   * array of field values in declaration order.
   */
  open(spec: DialogSpec): Promise<any> {
    return new Promise((resolve) => {
      const id = ++nextId;
      this.queue = [...this.queue, { id, spec, resolve }];
    });
  }

  close(id: number, value: any): void {
    const entry = this.queue.find((q) => q.id === id);
    if (!entry) return;
    this.queue = this.queue.filter((q) => q.id !== id);
    entry.resolve(value);
  }

  /** True while any dialog is up — the global shortcut handler checks this. */
  get open_(): boolean { return this.queue.length > 0; }
}

export const dialogs = new Dialogs();

export const uiDialog = (spec: DialogSpec): Promise<any> => dialogs.open(spec);

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
  return r ? r[0] : null;
}
