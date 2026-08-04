/**
 * Drag-to-reorder for a keyed list of rows.
 *
 * Applied to each row element. The action owns only the drag protocol; the caller owns
 * the array and does the move, which is what keeps this usable for four different row
 * shapes in the settings modal without any of them leaking in here.
 *
 * Order is not decoration in this app: `baseDirs` is scanned in order, and `start` /
 * `editors` are serialized as objects whose key order is their on-disk order. So a list
 * you cannot reorder is a list whose order you cannot fix once it is wrong.
 *
 * HTML5 drag-and-drop rather than pointer events: it is what the platform provides,
 * gives the drag image and the cursor for free, and does not need a global move listener.
 *
 * Keyboard users are not served by dragging, so the caller also renders ↑/↓ buttons —
 * see `moveRow` in SettingsModal. This is the mouse affordance, not the only one.
 */
export interface ReorderableOptions {
  /** This row's current position. */
  index: number;
  /** Move the item at `from` to `to`. The caller mutates its own array. */
  onmove: (from: number, to: number) => void;
}

/** The row currently being dragged, shared across every element of one list. */
let dragging: { index: number } | null = null;

export function reorderable(node: HTMLElement, options: ReorderableOptions) {
  let opts = options;

  node.draggable = true;

  const onDragStart = (e: DragEvent) => {
    dragging = { index: opts.index };
    node.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      // Firefox refuses to start a drag unless something is set.
      e.dataTransfer.setData('text/plain', String(opts.index));
    }
  };

  const onDragEnd = () => {
    dragging = null;
    node.classList.remove('dragging');
    node.classList.remove('dragover');
  };

  const onDragOver = (e: DragEvent) => {
    if (!dragging || dragging.index === opts.index) return;
    // preventDefault is what marks this a valid drop target; without it `drop` never fires.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    node.classList.add('dragover');
  };

  const onDragLeave = () => node.classList.remove('dragover');

  const onDrop = (e: DragEvent) => {
    node.classList.remove('dragover');
    if (!dragging || dragging.index === opts.index) return;
    e.preventDefault();
    opts.onmove(dragging.index, opts.index);
    dragging = null;
  };

  node.addEventListener('dragstart', onDragStart);
  node.addEventListener('dragend', onDragEnd);
  node.addEventListener('dragover', onDragOver);
  node.addEventListener('dragleave', onDragLeave);
  node.addEventListener('drop', onDrop);

  return {
    // `index` changes as rows move, so the action has to be told rather than capturing it.
    update(next: ReorderableOptions) { opts = next; },
    destroy() {
      node.removeEventListener('dragstart', onDragStart);
      node.removeEventListener('dragend', onDragEnd);
      node.removeEventListener('dragover', onDragOver);
      node.removeEventListener('dragleave', onDragLeave);
      node.removeEventListener('drop', onDrop);
    },
  };
}

/**
 * Move an item within an array, returning a NEW array.
 *
 * Separate from the action so it can be tested without a DOM, and so every list in the
 * modal moves rows the same way.
 */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
