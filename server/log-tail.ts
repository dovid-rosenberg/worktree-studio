/*
 * Incremental log tailing — one implementation, for every log Studio keeps.
 *
 * `Servers.logs()` and `Runner.logs()` are the same operation on the same kind of file,
 * and runner.ts's docblock said so outright ("same contract as Servers.logs"). They were
 * not the same. Three divergences, all invisible until they bit:
 *
 *   ROTATION, handled OPPOSITE ways. Servers treats `offset > size` as "the file was
 *   truncated, re-read from the start". Runner clamped `from` to `size`, so `from >= size`
 *   held and it returned an empty tail on EVERY subsequent poll — a run whose log rotated
 *   simply stopped updating, forever.
 *
 *   UTF-8. Servers drops a clipped first line, "which also disposes of the half UTF-8
 *   sequence an arbitrary byte offset can land in the middle of". Runner sliced at a raw
 *   byte offset, so a multi-byte character straddling the window rendered as U+FFFD.
 *
 *   `skipped`. Servers reports how many bytes a bounded read jumped over. Runner did not,
 *   so a client could not tell a quiet log from one it had fallen behind.
 *
 * Two copies of a thing described as one contract is the shape this codebase keeps
 * producing; this is that rule with a single home.
 */
import fs from 'fs';

/** A single read never pulls more than this into memory, however far behind the caller is. */
export const TAIL_MAX_BYTES = 512 * 1024;

export interface LogTail {
  /** Pass this back as `offset` next time to get only what arrived since. */
  offset: number;
  text: string;
  size: number;
  /** Bytes the bounded read jumped over — a caller that has fallen behind needs to know. */
  skipped: number;
}

/** Read a byte range [start, end) as UTF-8. */
export function readRange(file: string, start: number, end: number): string {
  const len = end - start;
  if (len <= 0) return '';
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The last `lines` lines, read backwards from the end and capped at `maxBytes`.
 *
 * A first line the window clipped is dropped rather than shown as a fragment, which also
 * disposes of the half UTF-8 sequence an arbitrary byte offset can land in the middle of.
 */
export function readTail(file: string, lines: number, maxBytes = TAIL_MAX_BYTES): string {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return '';
  }
  const start = Math.max(0, size - maxBytes);
  let text = readRange(file, start, size);
  if (start > 0) {
    const nl = text.indexOf('\n');
    text = nl >= 0 ? text.slice(nl + 1) : '';
  }
  return text.split('\n').slice(-lines).join('\n');
}

/**
 * One log's tail: incremental when given an offset, the last N lines otherwise.
 *
 * `offset > size` means the file shrank — truncated or rotated — so the read restarts
 * from the beginning rather than waiting for it to grow back past a stale offset.
 */
export function tailFile(file: string | undefined, opts: { offset?: number; lines?: number } = {}): LogTail {
  const offset = typeof opts.offset === 'number' && Number.isFinite(opts.offset) ? opts.offset : null;
  const empty = { offset: offset ?? 0, text: '', size: 0, skipped: 0 };
  if (!file || !fs.existsSync(file)) return empty;
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return empty;
  }
  if (offset !== null) {
    const start = offset > size ? 0 : Math.max(0, offset);
    // A client that has been away — or a server that dumped a burst — must not be able to
    // make us allocate the whole gap in one Buffer.
    const from = Math.max(start, size - TAIL_MAX_BYTES);
    return { offset: size, text: readRange(file, from, size), size, skipped: from - start };
  }
  return { offset: size, text: readTail(file, opts.lines || 300), size, skipped: 0 };
}
