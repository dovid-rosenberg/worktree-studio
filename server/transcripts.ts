// The transcript reader. Claude Code appends a JSONL transcript per session to
// ~/.claude/projects/<slugified-cwd>/<claudeSessionId>.jsonl. This module locates
// the file for a Studio session, stream-parses it from a byte offset, and hands
// normalized entries to the two consumers that care: the search index and the
// token/cost telemetry. One reader, two features — the parsing quirks below are
// non-obvious enough that duplicating them would guarantee drift.
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as pricing from './pricing.ts';
import type { IsoTimestamp, TranscriptEntry, Usage, UsageByModel, UsageTotals } from './types.ts';

const NL = 0x0a;
const CR = 0x0d;

// Tool results are routinely megabytes (a full file read, a 10k-line log). We index
// and return the head only — enough to be a useful search hit, small enough that the
// index stays a fraction of the transcript.
const BLOCK_CAP = 4000;
const ENTRY_CAP = 12000;

// ---- what a transcript line looks like from here ----------------------------
//
// A transcript is schema-drifting input written by another program, so every field
// is optional. Anything the code below inspects before using it is `unknown` here —
// the guard, not the declaration, is what makes it safe to read.

interface RawCacheCreation {
  ephemeral_1h_input_tokens?: unknown;
  ephemeral_5m_input_tokens?: unknown;
}

interface RawServerToolUse {
  web_search_requests?: unknown;
  web_fetch_requests?: unknown;
}

interface RawUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_creation?: unknown;
  cache_read_input_tokens?: unknown;
  server_tool_use?: unknown;
  speed?: unknown;
}

interface RawBlock {
  type?: string;
  text?: unknown;
  thinking?: unknown;
  name?: unknown;
  input?: unknown;
  content?: unknown;
}

interface RawMessage {
  role?: string;
  id?: string;
  model?: string;
  content?: unknown;
  usage?: unknown;
}

/** One parsed JSONL line, limited to the fields this module reads. */
export interface TranscriptRecord {
  type?: string;
  message?: unknown;
  timestamp?: unknown;
  uuid?: string;
  parentUuid?: string;
  requestId?: string;
  cwd?: string;
  gitBranch?: string;
  isSidechain?: unknown;
}

// ---- locating a transcript --------------------------------------------------

export interface LocateOptions {
  root?: string;
}

/** The session fields locate() reads. A full `Session` satisfies it. */
export interface LocatableSession {
  claudeSessionId?: string | null;
  home?: string | null;
  worktreePath?: string | null;
  repoPath?: string | null;
  repos?: Array<{ worktreePath?: string | null; repoPath?: string | null }> | null;
}

export type LocateResult =
  | { found: true; file: string; cwd: string | null; slug: string; viaScan?: true }
  | { found: false; reason: string };

function projectsRoot(opts?: LocateOptions | null): string {
  return opts?.root || process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
}

// Claude Code names a project directory after the launch cwd with every
// non-alphanumeric byte replaced by '-'. Verified against every project directory
// on this machine (12/12 exact): the leading '/' becomes a leading '-', dots and
// underscores collapse to '-', and '/.worktrees/' therefore becomes '--worktrees-'.
//   /Users/me/code/worktree-studio
//     → -Users-me-code-worktree-studio
//   /Users/me/code/api/.worktrees/fix-login
//     → -Users-me-code-api--worktrees-fix-login
function projectSlug(cwd: string | null | undefined): string {
  return String(cwd || '').replace(/[^A-Za-z0-9]/g, '-');
}

// A claudeSessionId is a uuid, and it is UNTRUSTED: it arrives verbatim in a
// SessionStart hook payload (`session_id`) and is then joined into a filesystem path.
// `../../..` in it escapes the transcript root, so locate() would happily point the
// reader — and the indexer — at any .jsonl on the machine. Validate the shape rather
// than sanitising it: anything that is not a uuid is not a session id, so there is
// nothing to salvage.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isSessionId(id: unknown): id is string {
  return typeof id === 'string' && UUID.test(id);
}

// Where a session's transcript lives. `session.home` tracks the cwd claude is
// actually running in (promote sends `/cd`, which relocates BOTH cwd and transcript),
// but a promote whose `/cd` never landed leaves `home` pointing at the old dir — so we
// try every directory this session has ever owned before falling back to a scan of the
// project dirs. Claude session ids are uuids, so a filename match is unambiguous.
function locate(session: LocatableSession | null | undefined, opts: LocateOptions = {}): LocateResult {
  if (!session?.claudeSessionId) return { found: false, reason: 'session has no claudeSessionId yet' };
  const id = session.claudeSessionId;
  if (!isSessionId(id)) return { found: false, reason: 'claudeSessionId is not a uuid' };
  const root = projectsRoot(opts);
  const seen = new Set<string>();
  const candidates = [session.home, session.worktreePath, session.repoPath];
  for (const r of session.repos || []) candidates.push(r.worktreePath, r.repoPath);
  for (const cwd of candidates) {
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    const slug = projectSlug(cwd);
    const file = path.join(root, slug, `${id}.jsonl`);
    if (fs.existsSync(file)) return { found: true, file, cwd, slug };
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return { found: false, reason: `no projects dir at ${root}` };
  }
  for (const slug of entries) {
    const file = path.join(root, slug, `${id}.jsonl`);
    if (fs.existsSync(file)) return { found: true, file, slug, cwd: null, viaScan: true };
  }
  return { found: false, reason: 'transcript not found' };
}

// ---- streaming --------------------------------------------------------------

export interface ScanOptions {
  /** Byte offset to resume from. */
  start?: number;
}

export interface ScanStats {
  offset: number;
  size: number;
  lines: number;
  parsed: number;
  skipped: number;
  truncatedTail: boolean;
  stopped: boolean;
}

/** Returning false stops the read early. */
type RecordSink = (rec: TranscriptRecord) => boolean | undefined;

// Stream a JSONL file from a byte offset, invoking onRecord for each COMPLETE line.
//
// Two properties make incremental indexing safe:
//  - We stop at the last newline and report that byte as `offset`. Transcripts are
//    appended live, so the tail is routinely a half-written line; refusing to parse
//    it means the next scan from `offset` picks the record up whole.
//  - A `start` past EOF means the file was rotated or rewritten under us, so we
//    restart from 0 rather than slicing into the middle of a line.
//
// onRecord may return false to stop early (search does; indexing must not, because a
// short read would persist a bogus offset).
function scan(file: string, opts: ScanOptions = {}, onRecord?: RecordSink): Promise<ScanStats> {
  return new Promise<ScanStats>((resolve, reject) => {
    const out: ScanStats = {
      offset: 0,
      size: 0,
      lines: 0,
      parsed: 0,
      skipped: 0,
      truncatedTail: false,
      stopped: false,
    };
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return resolve(out);
    }
    out.size = size;

    const from0 = opts.start;
    let start = typeof from0 === 'number' && Number.isFinite(from0) ? Math.max(0, Math.floor(from0)) : 0;
    if (start > size) start = 0; // file shrank → re-read from the top
    out.offset = start;
    if (start >= size) return resolve(out);

    const stream = fs.createReadStream(file, { start, end: size - 1 });
    let pending: Buffer[] = [];
    let pendingLen = 0;
    let pos = start;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      resolve(out);
    };

    const handle = (raw: Buffer) => {
      let buf = raw;
      if (buf.length && buf[buf.length - 1] === CR) buf = buf.subarray(0, buf.length - 1);
      if (!buf.length) return;
      const text = buf.toString('utf8');
      if (!text.trim()) return;
      out.lines++;
      let rec: unknown;
      try {
        rec = JSON.parse(text);
      } catch {
        out.skipped++;
        return;
      }
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
        out.skipped++;
        return;
      }
      out.parsed++;
      if (onRecord && onRecord(rec as TranscriptRecord) === false) {
        out.stopped = true;
        stream.destroy();
      }
    };

    // No encoding is set on the stream, so every chunk is a Buffer — which is what
    // lets us find the newline by byte and slice without re-decoding.
    stream.on('data', (chunk: Buffer) => {
      pending.push(chunk);
      pendingLen += chunk.length;
      if (chunk.indexOf(NL) === -1) return; // no line boundary yet — keep buffering
      const all = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingLen);
      let from = 0;
      let i: number;
      while (!out.stopped && (i = all.indexOf(NL, from)) !== -1) {
        pos += i - from + 1;
        handle(all.subarray(from, i));
        from = i + 1;
      }
      out.offset = pos;
      const rest = all.subarray(from);
      pending = rest.length ? [rest] : [];
      pendingLen = rest.length;
    });
    stream.on('error', (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    });
    stream.on('close', finish);
    stream.on('end', () => {
      out.truncatedTail = pendingLen > 0;
      finish();
    });
  });
}

// ---- content extraction -----------------------------------------------------

function safeJson(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

function blockText(b: unknown): string {
  if (typeof b === 'string') return b;
  if (!b || typeof b !== 'object') return '';
  const blk = b as RawBlock;
  switch (blk.type) {
    case 'text':
      return String(blk.text || '');
    case 'thinking':
      return String(blk.thinking || '');
    case 'tool_use':
      return `[tool ${String(blk.name || '?')}] ${safeJson(blk.input)}`;
    case 'tool_result':
      return contentText(blk.content);
    case 'image':
      return '[image]';
    default:
      return '';
  }
}

function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  const parts: string[] = [];
  for (const b of c) {
    const t = blockText(b);
    if (t) parts.push(t.length > BLOCK_CAP ? `${t.slice(0, BLOCK_CAP)}…` : t);
  }
  return parts.join('\n');
}

// ---- usage normalization ----------------------------------------------------

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// message.usage → a flat shape the price table understands. The per-TTL cache
// breakdown matters: a 1h cache write costs 2x the base input rate and a 5m write
// 1.25x, so pricing the lump `cache_creation_input_tokens` as 5m would understate
// any session using the 1h cache (which this codebase's sessions do).
function normalizeUsage(u: unknown): Usage | null {
  if (!u || typeof u !== 'object') return null;
  const raw = u as RawUsage;
  const totalWrite = num(raw.cache_creation_input_tokens);
  const cc =
    raw.cache_creation && typeof raw.cache_creation === 'object'
      ? (raw.cache_creation as RawCacheCreation)
      : null;
  let w1h = cc ? num(cc.ephemeral_1h_input_tokens) : 0;
  let w5m = cc ? num(cc.ephemeral_5m_input_tokens) : 0;
  if (!cc) {
    w1h = 0;
    w5m = totalWrite;
  } else if (w1h + w5m !== totalWrite) w5m = Math.max(0, totalWrite - w1h);
  const st: RawServerToolUse =
    raw.server_tool_use && typeof raw.server_tool_use === 'object'
      ? (raw.server_tool_use as RawServerToolUse)
      : {};
  return {
    input: num(raw.input_tokens),
    output: num(raw.output_tokens),
    cacheWrite5m: w5m,
    cacheWrite1h: w1h,
    cacheWrite: totalWrite,
    cacheRead: num(raw.cache_read_input_tokens),
    webSearch: num(st.web_search_requests),
    webFetch: num(st.web_fetch_requests),
    speed: typeof raw.speed === 'string' ? raw.speed : null,
  };
}

// A raw JSONL record → the entry shape both consumers use, or null for the line
// types that carry no searchable text and no usage (mode, permission-mode,
// last-prompt, ai-title, file-history-snapshot, queue-operation, …). Unknown types
// are dropped the same way — the format grows and we should not crash on it.
function toEntry(rec: TranscriptRecord): TranscriptEntry | null {
  const type = rec.type;
  if (type !== 'assistant' && type !== 'user') return null;
  const msg: RawMessage = rec.message && typeof rec.message === 'object' ? (rec.message as RawMessage) : {};
  let text = type === 'user' ? contentText(msg.content) : contentText(msg.content);
  if (text.length > ENTRY_CAP) text = `${text.slice(0, ENTRY_CAP)}…`;
  const ts: IsoTimestamp | null = typeof rec.timestamp === 'string' ? rec.timestamp : null;
  const tsMs = ts ? Date.parse(ts) : NaN;
  const usage = type === 'assistant' ? normalizeUsage(msg.usage) : null;
  return {
    kind: type,
    role: msg.role || type,
    uuid: rec.uuid || null,
    parentUuid: rec.parentUuid || null,
    // The API message id is the dedup key for usage — see aggregate().
    msgId: msg.id || null,
    requestId: rec.requestId || null,
    ts,
    tsMs: Number.isFinite(tsMs) ? tsMs : null,
    model: type === 'assistant' ? msg.model || null : null,
    speed: usage ? usage.speed : null,
    cwd: rec.cwd || null,
    gitBranch: rec.gitBranch || null,
    sidechain: rec.isSidechain === true,
    text,
    usage,
  };
}

/** Returning false stops the read early. */
type EntrySink = (e: TranscriptEntry) => boolean | undefined;

// Stream a transcript and hand normalized entries to `onEntry`. Same offset/early-stop
// contract as scan().
function readTranscript(file: string, opts: ScanOptions = {}, onEntry?: EntrySink): Promise<ScanStats> {
  return scan(file, opts, (rec) => {
    const e = toEntry(rec);
    if (!e) return;
    return onEntry ? onEntry(e) : undefined;
  });
}

// ---- aggregation ------------------------------------------------------------

/** The token counters every accumulator carries — a `Usage` with no `speed`. */
export type TokenTotals = Omit<Usage, 'speed'>;

/** A per-model accumulator, before a rate has been applied to it. */
type ModelAccum = Omit<UsageByModel, 'costUsd' | 'priced'>;

function blankTotals(): TokenTotals {
  return {
    input: 0,
    output: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheWrite: 0,
    cacheRead: 0,
    webSearch: 0,
    webFetch: 0,
  };
}

function addUsage(t: TokenTotals, u: TokenTotals): void {
  t.input += u.input;
  t.output += u.output;
  t.cacheWrite5m += u.cacheWrite5m;
  t.cacheWrite1h += u.cacheWrite1h;
  t.cacheWrite += u.cacheWrite;
  t.cacheRead += u.cacheRead;
  t.webSearch += u.webSearch;
  t.webFetch += u.webFetch;
}

// The dedup key for one API response. Claude Code writes ONE JSONL LINE PER CONTENT
// BLOCK and repeats the identical message.usage on every one of them — a response
// with a thinking block, a text block and two tool_use blocks appears four times.
// Summing lines over-counts by ~2.9x on a tool-heavy session (measured). Dedup on
// the API message id; fall back to requestId, then the line uuid (always unique, so
// a record with neither id degrades to counting once rather than being dropped).
function usageKey(e: TranscriptEntry): string | null {
  return e.msgId || e.requestId || e.uuid;
}

// Total tokens + derived cost for one transcript. Returns per-model breakdowns
// because a single session routinely spans models (opus-4-8 + fable-5 subagents),
// and cost is meaningless without knowing which rate applied.
async function aggregate(file: string, opts: ScanOptions = {}): Promise<UsageTotals> {
  const seen = new Set<string>();
  const totals = blankTotals();
  const models = new Map<string, ModelAccum>();
  const unpriced = new Set<string>();
  let assistantMessages = 0;
  let userMessages = 0;
  let firstAt: number | null = null;
  let lastAt: number | null = null;

  const stats = await readTranscript(file, opts, (e) => {
    if (e.tsMs) {
      if (firstAt === null || e.tsMs < firstAt) firstAt = e.tsMs;
      if (lastAt === null || e.tsMs > lastAt) lastAt = e.tsMs;
    }
    if (e.kind === 'user') {
      userMessages++;
      return;
    }
    if (!e.usage) return;
    const key = usageKey(e);
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    assistantMessages++;
    addUsage(totals, e.usage);
    const model = e.model || 'unknown';
    let m = models.get(model);
    if (!m) {
      m = { model, speed: e.speed, messages: 0, ...blankTotals() };
      models.set(model, m);
    }
    m.messages++;
    addUsage(m, e.usage);
  });

  let costUsd = 0;
  let allPriced = true;
  const byModel: UsageByModel[] = [];
  for (const m of models.values()) {
    const { usd, priced } = pricing.costOf(m.model, m, { speed: m.speed });
    if (!priced) {
      if (pricing.isBillable(m.model)) {
        allPriced = false;
        unpriced.add(m.model);
      }
    } else costUsd += usd;
    byModel.push({ ...m, costUsd: pricing.round(usd), priced });
  }
  byModel.sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0) || b.output - a.output);

  return {
    ...totals,
    assistantMessages,
    userMessages,
    firstAt,
    lastAt,
    byModel,
    costUsd: pricing.round(costUsd),
    costIsEstimate: true,
    unpricedModels: [...unpriced],
    complete: allPriced,
    file,
    bytes: stats.size,
    offset: stats.offset,
    malformedLines: stats.skipped,
    truncatedTail: stats.truncatedTail,
  };
}

// ---- direct (unindexed) search ---------------------------------------------

export interface SearchOptions {
  query?: string;
  limit?: number;
}

/** One hit, as the file-scan backend reports it. */
export interface SearchHit {
  uuid: string | null;
  role: string;
  model: string | null;
  ts: IsoTimestamp | null;
  tsMs: number | null;
  gitBranch: string | null;
  sidechain: boolean;
  snippet: string;
}

// Case-insensitive substring search straight off the file. The sqlite/FTS5 index in
// transcript-index.ts is the fast path; this exists so search still works before a
// session has been indexed (and so the reader is testable without sqlite).
async function search(file: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
  const q = String(opts.query || '').toLowerCase();
  const limit = Math.max(1, Math.min(500, opts.limit || 50));
  if (!q) return [];
  const hits: SearchHit[] = [];
  await readTranscript(file, {}, (e) => {
    if (!e.text) return;
    const i = e.text.toLowerCase().indexOf(q);
    if (i === -1) return;
    hits.push({
      uuid: e.uuid,
      role: e.role,
      model: e.model,
      ts: e.ts,
      tsMs: e.tsMs,
      gitBranch: e.gitBranch,
      sidechain: e.sidechain,
      snippet: excerpt(e.text, i, q.length),
    });
    if (hits.length >= limit) return false;
  });
  return hits;
}

function excerpt(text: string, at: number, len: number, pad = 90): string {
  const start = Math.max(0, at - pad);
  const end = Math.min(text.length, at + len + pad);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`;
}

export {
  projectsRoot,
  projectSlug,
  isSessionId,
  locate,
  scan,
  readTranscript,
  toEntry,
  normalizeUsage,
  contentText,
  aggregate,
  search,
  blankTotals,
  addUsage,
  usageKey,
  excerpt,
};
