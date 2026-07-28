// Incremental search + telemetry index over the transcripts of sessions Studio
// manages. Deliberately NOT an index of all of ~/.claude/projects (308MB of other
// people's work) — only what's keyed off a session's claudeSessionId, so the index
// stays small, fast, and always relevant.
//
// Storage is node:sqlite (built into Node 22, zero new deps). Indexing is byte-offset
// incremental, the same trick servers.js uses to tail dev-server logs: we remember
// where we stopped and only ever read the bytes appended since. A full re-read of a
// 22MB transcript on every Stop hook would be the obvious wrong thing.
import fs from 'fs';
import path from 'path';
import * as transcripts from './transcripts.js';
import * as pricing from './pricing.js';

// node:sqlite is experimental in Node 22 (it prints an ExperimentalWarning on first
// load). If it or FTS5 is missing we degrade to the file-scan search in
// transcripts.js rather than taking the whole feature down.
//
// process.getBuiltinModule, not `import`: a static import of a missing builtin is a
// link-time failure that takes the whole module graph down, and `await import` would
// make every importer of this file async for a value we need synchronously here.
let sqlite = null;
let loadError = null;
try { sqlite = process.getBuiltinModule('node:sqlite'); } catch (e) { loadError = e.message; }
if (!sqlite && !loadError) loadError = 'not built into this node';

function ftsAvailable(db) {
  try {
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS _fts_probe USING fts5(x)');
    db.exec('DROP TABLE IF EXISTS _fts_probe');
    return true;
  } catch { return false; }
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
-- Usage is keyed on the API message id, not the line uuid: Claude Code writes one
-- line per content block and repeats the identical usage on each, so (session, msg)
-- as a PRIMARY KEY with INSERT OR IGNORE is what makes token totals correct AND
-- makes re-indexing the same bytes idempotent.
CREATE TABLE IF NOT EXISTS usage (
  session_id     TEXT NOT NULL,
  msg_id         TEXT NOT NULL,
  ts_ms          INTEGER,
  model          TEXT,
  speed          TEXT,
  input          INTEGER NOT NULL DEFAULT 0,
  output         INTEGER NOT NULL DEFAULT 0,
  cache_write_5m INTEGER NOT NULL DEFAULT 0,
  cache_write_1h INTEGER NOT NULL DEFAULT 0,
  cache_read     INTEGER NOT NULL DEFAULT 0,
  web_search     INTEGER NOT NULL DEFAULT 0,
  web_fetch      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, msg_id)
);
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

// FTS5 MATCH is a query language, not a search box: a bare `OR`, an unbalanced quote,
// or a stray `*` is a syntax error rather than a search for those characters. Quote
// every term as a literal phrase and AND them together — predictable and injection-proof.
// Double-quoted runs in the user's input are preserved as phrases.
function ftsQuery(q) {
  const terms = String(q || '').match(/"[^"]*"|\S+/g) || [];
  const cleaned = terms
    .map((t) => t.replace(/"/g, ' ').trim())
    .filter(Boolean);
  if (!cleaned.length) return null;
  return cleaned.map((t) => `"${t}"`).join(' AND ');
}

// LIKE fallback: escape the wildcards so a query containing % or _ searches for them.
function likePattern(q) {
  return `%${String(q || '').replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

class TranscriptIndex {
  constructor(opts = {}) {
    this.file = opts.file || ':memory:';
    this.root = opts.root || null; // override ~/.claude/projects (tests)
    this.db = null;
    this.fts = false;
    this.ready = false;
    this.error = null;
    this._indexing = new Set(); // session ids with an index pass in flight
    this.open();
  }

  open() {
    if (!sqlite) { this.error = `node:sqlite unavailable (${loadError})`; return; }
    try {
      if (this.file !== ':memory:') fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.db = new sqlite.DatabaseSync(this.file);
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec(SCHEMA);
      this.fts = ftsAvailable(this.db);
      if (this.fts) this.db.exec(FTS_SCHEMA);
      this.ready = true;
    } catch (e) {
      this.error = e.message;
      this.ready = false;
    }
  }

  close() { if (this.db) { try { this.db.close(); } catch { /* */ } this.db = null; this.ready = false; } }

  status() {
    return {
      ready: this.ready,
      backend: this.ready ? (this.fts ? 'sqlite-fts5' : 'sqlite-like') : 'file-scan',
      fts5: this.fts,
      file: this.file,
      error: this.error,
      sessions: this.ready ? this.db.prepare('SELECT COUNT(*) n FROM files').get().n : 0,
      messages: this.ready ? this.db.prepare('SELECT COUNT(*) n FROM messages').get().n : 0,
    };
  }

  // Index the bytes appended since the last pass. Returns what changed so the caller
  // can log or ignore it. Cheap and safe to call on every Stop hook: with no new
  // bytes it does a stat and returns.
  async index(session, opts = {}) {
    if (!this.ready) return { ok: false, reason: this.error || 'index unavailable' };
    const id = session && session.id;
    if (!id) return { ok: false, reason: 'no session id' };
    if (this._indexing.has(id)) return { ok: true, skipped: 'in flight' };

    const loc = transcripts.locate(session, { root: this.root });
    if (!loc.found) return { ok: false, reason: loc.reason };

    const prev = this.db.prepare('SELECT path, offset FROM files WHERE session_id = ?').get(id);
    // A relocated transcript (promote moves it) means the new file holds the whole
    // history — the old offset would silently skip everything before the move.
    let start = prev && prev.path === loc.file && !opts.full ? prev.offset : 0;
    if (opts.full) start = 0;

    let size = 0;
    try { size = fs.statSync(loc.file).size; } catch { return { ok: false, reason: 'transcript vanished' }; }
    if (start === size && prev && prev.path === loc.file) {
      return { ok: true, file: loc.file, added: 0, offset: start, size, upToDate: true };
    }

    this._indexing.add(id);
    try {
      return await this._ingest(id, loc.file, session.claudeSessionId, start);
    } finally {
      this._indexing.delete(id);
    }
  }

  async _ingest(id, file, claudeSessionId, start) {
    const insMsg = this.db.prepare(
      'INSERT OR IGNORE INTO messages (session_id, uuid, role, ts, ts_ms, model, git_branch, sidechain, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const insUsage = this.db.prepare(
      'INSERT OR IGNORE INTO usage (session_id, msg_id, ts_ms, model, speed, input, output, cache_write_5m, cache_write_1h, cache_read, web_search, web_fetch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
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
    let stats;
    this.db.exec('BEGIN');
    try {
      stats = await transcripts.readTranscript(file, { start }, (e) => {
        if (e.uuid && e.text) {
          insMsg.run(id, e.uuid, e.role, e.ts, e.tsMs, e.model, e.gitBranch, e.sidechain ? 1 : 0, e.text);
          added++;
        }
        if (e.usage) {
          const key = transcripts.usageKey(e);
          if (key) {
            insUsage.run(id, key, e.tsMs, e.model, e.speed, e.usage.input, e.usage.output,
              e.usage.cacheWrite5m, e.usage.cacheWrite1h, e.usage.cacheRead, e.usage.webSearch, e.usage.webFetch);
          }
        }
      });
      this.db.prepare(
        `INSERT INTO files (session_id, path, claude_session_id, offset, size, entries, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           path=excluded.path, claude_session_id=excluded.claude_session_id,
           offset=excluded.offset, size=excluded.size,
           entries=files.entries+excluded.entries, indexed_at=excluded.indexed_at`
      ).run(id, file, claudeSessionId || null, stats.offset, stats.size, added, Date.now());
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return {
      ok: true, file, added, offset: stats.offset, size: stats.size,
      malformedLines: stats.skipped, truncatedTail: stats.truncatedTail,
    };
  }

  // Drop everything for a session (its Studio session was closed).
  forget(sessionId) {
    if (!this.ready) return;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM usage WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM files WHERE session_id = ?').run(sessionId);
      this.db.exec('COMMIT');
    } catch { this.db.exec('ROLLBACK'); }
  }

  // Search returns enough to be actionable without opening the transcript: the
  // matching text, which session it came from, when, and who said it.
  search(query, opts = {}) {
    if (!this.ready) return { ok: false, reason: this.error || 'index unavailable', hits: [] };
    const limit = Math.max(1, Math.min(200, Number(opts.limit) || 30));
    const where = [];
    const args = [];
    let sql;

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

    if (opts.sessionId) { where.push('m.session_id = ?'); args.push(opts.sessionId); }
    if (opts.role) { where.push('m.role = ?'); args.push(opts.role); }
    if (opts.since) { where.push('m.ts_ms >= ?'); args.push(Number(opts.since)); }
    if (where.length) sql += ` AND ${where.join(' AND ')}`;
    sql += opts.order === 'recent' || !this.fts ? ' ORDER BY m.ts_ms DESC' : ' ORDER BY rank';
    sql += ' LIMIT ?';
    args.push(limit);

    const rows = this.db.prepare(sql).all(...args);
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
        snippet: String(r.snippet || '').replace(/\s+/g, ' ').trim(),
      })),
      total: rows.length,
    };
  }

  // Per-model token rollup for one session (or all of them), straight out of the
  // usage table — no transcript re-read.
  usageRows(sessionId) {
    if (!this.ready) return [];
    const sql = `SELECT session_id, model, speed, COUNT(*) messages,
                        SUM(input) input, SUM(output) output,
                        SUM(cache_write_5m) cw5m, SUM(cache_write_1h) cw1h,
                        SUM(cache_read) cache_read,
                        SUM(web_search) web_search, SUM(web_fetch) web_fetch,
                        MIN(ts_ms) first_at, MAX(ts_ms) last_at
                 FROM usage ${sessionId ? 'WHERE session_id = ?' : ''}
                 GROUP BY session_id, model, speed`;
    return sessionId ? this.db.prepare(sql).all(sessionId) : this.db.prepare(sql).all();
  }
}

// Turn usageRows() output into the priced shape the API returns. Kept out of the
// class so telemetry.js-style callers can roll up across sessions or features with
// the same code path.
function summarize(rows) {
  const totals = transcripts.blankTotals();
  const unpriced = new Set();
  let costUsd = 0;
  let messages = 0;
  let firstAt = null;
  let lastAt = null;
  const byModel = [];

  for (const r of rows) {
    const u = {
      input: r.input || 0, output: r.output || 0,
      cacheWrite5m: r.cw5m || 0, cacheWrite1h: r.cw1h || 0,
      cacheWrite: (r.cw5m || 0) + (r.cw1h || 0),
      cacheRead: r.cache_read || 0,
      webSearch: r.web_search || 0, webFetch: r.web_fetch || 0,
    };
    transcripts.addUsage(totals, u);
    messages += r.messages || 0;
    if (r.first_at && (firstAt === null || r.first_at < firstAt)) firstAt = r.first_at;
    if (r.last_at && (lastAt === null || r.last_at > lastAt)) lastAt = r.last_at;
    const { usd, priced } = pricing.costOf(r.model, u, { speed: r.speed });
    if (priced) costUsd += usd;
    else if (pricing.isBillable(r.model)) unpriced.add(r.model || 'unknown');
    byModel.push({ model: r.model, speed: r.speed, messages: r.messages, ...u, costUsd: pricing.round(usd), priced });
  }
  byModel.sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0) || b.output - a.output);

  return {
    ...totals,
    messages,
    firstAt,
    lastAt,
    byModel,
    costUsd: pricing.round(costUsd),
    costIsEstimate: true,
    unpricedModels: [...unpriced],
  };
}

const sqliteAvailable = () => !!sqlite;

export { TranscriptIndex, summarize, ftsQuery, likePattern, sqliteAvailable };
