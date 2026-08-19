// Incremental search index over the transcripts of sessions Studio manages.
// Deliberately NOT an index of all of ~/.claude/projects (308MB of other people's
// work) — only what's keyed off a session's claudeSessionId, so the index stays
// small, fast, and always relevant.
//
// Storage is node:sqlite (built into Node 22, zero new deps). Indexing is byte-offset
// incremental, the same trick servers.ts uses to tail dev-server logs: we remember
// where we stopped and only ever read the bytes appended since. A full re-read of a
// 22MB transcript on every Stop hook would be the obvious wrong thing.
import fs from 'fs';
import path from 'path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import * as transcripts from './transcripts.ts';
import type { LocatableSession, ScanStats, SearchHit } from './transcripts.ts';

// node:sqlite is experimental in Node 22 (it prints an ExperimentalWarning on first
// load). If it or FTS5 is missing we degrade to the file-scan search in
// transcripts.ts rather than taking the whole feature down.
//
// process.getBuiltinModule, not `import`: a static import of a missing builtin is a
// link-time failure that takes the whole module graph down, and `await import` would
// make every importer of this file async for a value we need synchronously here.
let sqlite: typeof import('node:sqlite') | null = null;
let loadError: string | null = null;
try {
  sqlite = process.getBuiltinModule('node:sqlite');
} catch (e) {
  loadError = (e as Error).message;
}
if (!sqlite && !loadError) loadError = 'not built into this node';

function ftsAvailable(db: DatabaseSync): boolean {
  try {
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS _fts_probe USING fts5(x)');
    db.exec('DROP TABLE IF EXISTS _fts_probe');
    return true;
  } catch {
    return false;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  session_id        TEXT PRIMARY KEY,
  path              TEXT NOT NULL,
  claude_session_id TEXT,
  offset            INTEGER NOT NULL DEFAULT 0,
  size              INTEGER NOT NULL DEFAULT 0,
  entries           INTEGER NOT NULL DEFAULT 0,
  indexed_at        INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  uuid       TEXT NOT NULL,
  role       TEXT,
  ts         TEXT,
  ts_ms      INTEGER,
  model      TEXT,
  git_branch TEXT,
  sidechain  INTEGER NOT NULL DEFAULT 0,
  body       TEXT,
  UNIQUE(session_id, uuid)
);
CREATE INDEX IF NOT EXISTS messages_session_ts ON messages(session_id, ts_ms);
`;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(body, content='messages', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;
`;

// ---- what comes back out of sqlite ------------------------------------------
//
// A row is shaped by the SELECT that produced it, not by the driver, so each one
// gets a named type. Only _ingest() writes these tables and it inserts from a
// normalized TranscriptEntry, so a column the schema leaves nullable is null only
// where the entry itself allows it — hence `uuid` and `role` are strings here while
// `ts`, `model` and `git_branch` are not.

type CountRow = { n: number };

type FileRow = { path: string; offset: number };

type MessageRow = {
  session_id: string;
  uuid: string;
  role: string;
  ts: string | null;
  ts_ms: number | null;
  model: string | null;
  git_branch: string | null;
  sidechain: number;
  snippet: string | null;
};

// COUNT(*) always answers with exactly one row; get() is typed for the general case.
function countOf(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as CountRow | undefined;
  return row ? row.n : 0;
}

// ---- the index ---------------------------------------------------------------

export type IndexBackend = 'sqlite-fts5' | 'sqlite-like' | 'file-scan';

export interface TranscriptIndexOptions {
  file?: string;
  root?: string | null;
}

export interface IndexStatus {
  ready: boolean;
  backend: IndexBackend;
  fts5: boolean;
  file: string;
  error: string | null;
  sessions: number;
  messages: number;
}

/** The session fields index() reads. A full `Session` satisfies it. */
export interface IndexableSession extends LocatableSession {
  id?: string | null;
}

export interface IndexOptions {
  /** Re-read the whole transcript instead of resuming from the stored offset. */
  full?: boolean;
}

/** A pass that ran, or was skipped because one was already in flight. */
export interface IndexPass {
  ok: true;
  /** Set when a pass for this session was already in flight — nothing was read. */
  skipped?: string;
  file?: string;
  added?: number;
  offset?: number;
  size?: number;
  /** No bytes have been appended since the last pass. */
  upToDate?: boolean;
  malformedLines?: number;
  truncatedTail?: boolean;
}

export type IndexResult = { ok: false; reason: string } | IndexPass;

/** A sqlite hit is a file-scan hit plus the session it came from. */
export interface IndexSearchHit extends SearchHit {
  sessionId: string;
}

/** `limit` and `since` arrive off a query string, so they may still be strings. */
export interface IndexSearchOptions {
  limit?: number | string | null;
  sessionId?: string | null;
  role?: string | null;
  since?: number | string | null;
  order?: string | null;
}

export type IndexSearchResult =
  | { ok: false; reason: string; hits: IndexSearchHit[] }
  | { ok: true; backend: IndexBackend; query?: string | null; hits: IndexSearchHit[]; total: number };

// FTS5 MATCH is a query language, not a search box: a bare `OR`, an unbalanced quote,
// or a stray `*` is a syntax error rather than a search for those characters. Quote
// every term as a literal phrase and AND them together — predictable and injection-proof.
// Double-quoted runs in the user's input are preserved as phrases.
function ftsQuery(q: string | null | undefined): string | null {
  const terms = String(q || '').match(/"[^"]*"|\S+/g) || [];
  const cleaned = terms.map((t) => t.replace(/"/g, ' ').trim()).filter(Boolean);
  if (!cleaned.length) return null;
  return cleaned.map((t) => `"${t}"`).join(' AND ');
}

// LIKE fallback: escape the wildcards so a query containing % or _ searches for them.
function likePattern(q: string | null | undefined): string {
  return `%${String(q || '').replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

class TranscriptIndex {
  file: string;
  root: string | null;
  db: DatabaseSync | null;
  fts: boolean;
  ready: boolean;
  error: string | null;
  _indexing: Set<string>;

  constructor(opts: TranscriptIndexOptions = {}) {
    this.file = opts.file || ':memory:';
    this.root = opts.root || null; // override ~/.claude/projects (tests)
    this.db = null;
    this.fts = false;
    this.ready = false;
    this.error = null;
    this._indexing = new Set(); // session ids with an index pass in flight
    this.open();
  }

  open(): void {
    if (!sqlite) {
      this.error = `node:sqlite unavailable (${loadError})`;
      return;
    }
    try {
      if (this.file !== ':memory:') fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.db = new sqlite.DatabaseSync(this.file);
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec(SCHEMA);
      this.fts = ftsAvailable(this.db);
      if (this.fts) this.db.exec(FTS_SCHEMA);
      this.ready = true;
    } catch (e) {
      this.error = (e as Error).message;
      this.ready = false;
    }
  }

  // `ready` and `db` are separate fields that open() sets together, so every query
  // path reconciles them here once: a non-null handle IS the ready check, and the
  // types then carry that fact into the statements instead of re-testing a flag.
  _handle(): DatabaseSync | null {
    return this.ready ? this.db : null;
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* */
      }
      this.db = null;
      this.ready = false;
    }
  }

  status(): IndexStatus {
    const db = this._handle();
    return {
      ready: this.ready,
      backend: this.ready ? (this.fts ? 'sqlite-fts5' : 'sqlite-like') : 'file-scan',
      fts5: this.fts,
      file: this.file,
      error: this.error,
      sessions: db ? countOf(db, 'SELECT COUNT(*) n FROM files') : 0,
      messages: db ? countOf(db, 'SELECT COUNT(*) n FROM messages') : 0,
    };
  }

  // Index the bytes appended since the last pass. Returns what changed so the caller
  // can log or ignore it. Cheap and safe to call on every Stop hook: with no new
  // bytes it does a stat and returns.
  async index(session: IndexableSession | null | undefined, opts: IndexOptions = {}): Promise<IndexResult> {
    const db = this._handle();
    if (!db) return { ok: false, reason: this.error || 'index unavailable' };
    if (!session?.id) return { ok: false, reason: 'no session id' };
    const id = session.id;
    if (this._indexing.has(id)) return { ok: true, skipped: 'in flight' };

    const loc = transcripts.locate(session, { root: this.root || undefined });
    if (!loc.found) return { ok: false, reason: loc.reason };

    const prev = db.prepare('SELECT path, offset FROM files WHERE session_id = ?').get(id) as
      | FileRow
      | undefined;
    // A relocated transcript (promote moves it) means the new file holds the whole
    // history — the old offset would silently skip everything before the move.
    let start = prev && prev.path === loc.file && !opts.full ? prev.offset : 0;
    if (opts.full) start = 0;

    let size = 0;
    try {
      size = fs.statSync(loc.file).size;
    } catch {
      return { ok: false, reason: 'transcript vanished' };
    }
    if (start === size && prev && prev.path === loc.file) {
      return { ok: true, file: loc.file, added: 0, offset: start, size, upToDate: true };
    }

    this._indexing.add(id);
    try {
      return await this._ingest(db, id, loc.file, session.claudeSessionId, start);
    } finally {
      this._indexing.delete(id);
    }
  }

  // The handle is passed in rather than re-read off `this`: index() has already
  // established that the index is open, and threading it through keeps that fact
  // true by construction here.
  async _ingest(
    db: DatabaseSync,
    id: string,
    file: string,
    claudeSessionId: string | null | undefined,
    start: number,
  ): Promise<IndexPass> {
    const insMsg = db.prepare(
      'INSERT OR IGNORE INTO messages (session_id, uuid, role, ts, ts_ms, model, git_branch, sidechain, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    // Insert inside the reader's callback rather than collecting every entry first.
    // Incrementally that made no difference — a Stop hook appends one turn — but a full
    // reindex reads the whole file, and a 22MB transcript's worth of normalized entries
    // (each carrying up to 12KB of text) was being held in memory all at once for no
    // reason. Streaming straight into the statement keeps it flat.
    //
    // The transaction opens BEFORE the read so every insert lands inside it, which is
    // what makes the offset in `files` and the rows it accounts for commit together.
    let added = 0;
    let stats: ScanStats;
    db.exec('BEGIN');
    try {
      stats = await transcripts.readTranscript(file, { start }, (e) => {
        if (e.uuid && e.text) {
          insMsg.run(id, e.uuid, e.role, e.ts, e.tsMs, e.model, e.gitBranch, e.sidechain ? 1 : 0, e.text);
          added++;
        }
      });
      db.prepare(
        `INSERT INTO files (session_id, path, claude_session_id, offset, size, entries, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           path=excluded.path, claude_session_id=excluded.claude_session_id,
           offset=excluded.offset, size=excluded.size,
           entries=files.entries+excluded.entries, indexed_at=excluded.indexed_at`,
      ).run(id, file, claudeSessionId || null, stats.offset, stats.size, added, Date.now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return {
      ok: true,
      file,
      added,
      offset: stats.offset,
      size: stats.size,
      malformedLines: stats.skipped,
      truncatedTail: stats.truncatedTail,
    };
  }

  /**
   * Purge one session's rows.
   *
   * Not called on session removal: the index outlives the worktree, so a search for
   * something you discussed last month still finds it after the checkout is gone.
   * Kept for a real purge.
   */
  forget(sessionId: string): void {
    const db = this._handle();
    if (!db) return;
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
      db.prepare('DELETE FROM files WHERE session_id = ?').run(sessionId);
      db.exec('COMMIT');
    } catch {
      db.exec('ROLLBACK');
    }
  }

  // Search returns enough to be actionable without opening the transcript: the
  // matching text, which session it came from, when, and who said it.
  search(query: string | null | undefined, opts: IndexSearchOptions = {}): IndexSearchResult {
    const db = this._handle();
    if (!db) return { ok: false, reason: this.error || 'index unavailable', hits: [] };
    const limit = Math.max(1, Math.min(200, Number(opts.limit) || 30));
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    let sql: string;

    if (this.fts) {
      const match = ftsQuery(query);
      if (!match) return { ok: true, backend: 'sqlite-fts5', hits: [], total: 0 };
      sql = `SELECT m.session_id, m.uuid, m.role, m.ts, m.ts_ms, m.model, m.git_branch, m.sidechain,
                    snippet(messages_fts, 0, '«', '»', '…', 18) AS snippet
             FROM messages_fts f JOIN messages m ON m.id = f.rowid
             WHERE messages_fts MATCH ?`;
      args.push(match);
    } else {
      if (!String(query || '').trim()) return { ok: true, backend: 'sqlite-like', hits: [], total: 0 };
      sql = `SELECT m.session_id, m.uuid, m.role, m.ts, m.ts_ms, m.model, m.git_branch, m.sidechain,
                    substr(m.body, 1, 400) AS snippet
             FROM messages m
             WHERE m.body LIKE ? ESCAPE '\\'`;
      args.push(likePattern(query));
    }

    if (opts.sessionId) {
      where.push('m.session_id = ?');
      args.push(opts.sessionId);
    }
    if (opts.role) {
      where.push('m.role = ?');
      args.push(opts.role);
    }
    if (opts.since) {
      where.push('m.ts_ms >= ?');
      args.push(Number(opts.since));
    }
    if (where.length) sql += ` AND ${where.join(' AND ')}`;
    sql += opts.order === 'recent' || !this.fts ? ' ORDER BY m.ts_ms DESC' : ' ORDER BY rank';
    sql += ' LIMIT ?';
    args.push(limit);

    const rows = db.prepare(sql).all(...args) as MessageRow[];
    return {
      ok: true,
      backend: this.fts ? 'sqlite-fts5' : 'sqlite-like',
      query,
      hits: rows.map((r) => ({
        sessionId: r.session_id,
        uuid: r.uuid,
        role: r.role,
        model: r.model,
        ts: r.ts,
        tsMs: r.ts_ms,
        gitBranch: r.git_branch,
        sidechain: !!r.sidechain,
        snippet: String(r.snippet || '')
          .replace(/\s+/g, ' ')
          .trim(),
      })),
      total: rows.length,
    };
  }
}

export { TranscriptIndex, ftsQuery, likePattern };
