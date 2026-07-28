/* Transient bottom-right notices. Same timings as app.js: 3.2 s, 6 s for errors. */

let nextId = 0;

export interface Toast {
  id: number;
  msg: string;
  err: boolean;
}

class Toasts {
  items = $state<Toast[]>([]);

  push(msg: string, err = false): number {
    const id = ++nextId;
    this.items = [...this.items, { id, msg: String(msg), err }];
    setTimeout(() => this.dismiss(id), err ? 6000 : 3200);
    return id;
  }

  dismiss(id: number): void {
    this.items = this.items.filter((t) => t.id !== id);
  }
}

export const toasts = new Toasts();

export const toast = (msg: string, err = false): number => toasts.push(msg, err);
