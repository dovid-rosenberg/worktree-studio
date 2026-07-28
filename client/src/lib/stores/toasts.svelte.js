/* Transient bottom-right notices. Same timings as app.js: 3.2 s, 6 s for errors. */

let nextId = 0;

class Toasts {
  /** @type {{id:number, msg:string, err:boolean}[]} */
  items = $state([]);

  /**
   * @param {string} msg
   * @param {boolean} [err]
   */
  push(msg, err = false) {
    const id = ++nextId;
    this.items = [...this.items, { id, msg: String(msg), err }];
    setTimeout(() => this.dismiss(id), err ? 6000 : 3200);
    return id;
  }

  /** @param {number} id */
  dismiss(id) {
    this.items = this.items.filter((t) => t.id !== id);
  }
}

export const toasts = new Toasts();

/**
 * @param {string} msg
 * @param {boolean} [err]
 */
export const toast = (msg, err = false) => toasts.push(msg, err);
