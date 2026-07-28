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

/**
 * @typedef {{ type?: 'text'|'checkbox'|'select', label?: string, value?: any,
 *             placeholder?: string, options?: string[] }} DialogField
 * @typedef {{ title?: string, message?: string, messageHtml?: string,
 *             fields?: DialogField[], okLabel?: string, cancelLabel?: string,
 *             danger?: boolean }} DialogSpec
 */

let nextId = 0;

class Dialogs {
  /** @type {{id:number, spec:DialogSpec, resolve:(v:any)=>void}[]} */
  queue = $state([]);

  /** The dialog currently on screen — the head of the queue. */
  current = $derived(this.queue[0] || null);

  /**
   * @param {DialogSpec} spec
   * @returns {Promise<any>} `null` on cancel/Escape; `true` when there are no fields;
   *   otherwise an array of field values in declaration order.
   */
  open(spec) {
    return new Promise((resolve) => {
      const id = ++nextId;
      this.queue = [...this.queue, { id, spec, resolve }];
    });
  }

  /**
   * @param {number} id
   * @param {any} value
   */
  close(id, value) {
    const entry = this.queue.find((q) => q.id === id);
    if (!entry) return;
    this.queue = this.queue.filter((q) => q.id !== id);
    entry.resolve(value);
  }

  /** True while any dialog is up — the global shortcut handler checks this. */
  get open_() { return this.queue.length > 0; }
}

export const dialogs = new Dialogs();

/** @param {DialogSpec} spec */
export const uiDialog = (spec) => dialogs.open(spec);

/**
 * @param {string} message
 * @param {{ title?: string, okLabel?: string, danger?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
export async function uiConfirm(message, opts = {}) {
  const r = await dialogs.open({
    title: opts.title || 'Confirm',
    message,
    okLabel: opts.okLabel || 'OK',
    danger: opts.danger,
  });
  return r === true;
}

/**
 * @param {string} message
 * @param {string} [value]
 * @param {{ label?: string, placeholder?: string, okLabel?: string }} [opts]
 * @returns {Promise<string|null>}
 */
export async function uiPrompt(message, value = '', opts = {}) {
  const r = await dialogs.open({
    title: message,
    fields: [{ type: 'text', label: opts.label || '', value, placeholder: opts.placeholder || '' }],
    okLabel: opts.okLabel || 'OK',
  });
  return r ? r[0] : null;
}
