/*
 * Reading and writing sessions.json — the only record that a session exists at all.
 *
 * The file has been an unversioned bare array since the first commit, and the shape
 * inside it has already drifted three times: ids that were a microsecond clock reading
 * and are now UUIDs, `muxName` persisted so existing sessions keep the name they were
 * created with, the PENDING_TAB sentinel in `tabs`. Each of those was absorbed by
 * writing code that tolerates BOTH shapes forever, because there was nowhere to put a
 * migration and no way to know which shape a given file was. That tolerance is a cost
 * paid on every read, in every future version, for a conversion that could have run once.
 *
 * So: an envelope with a version, and a seam to migrate through. Nothing needs migrating
 * today — v1 is the current shape, and the only real work is recognising a pre-envelope
 * file as v0 and stamping it. The point is that the NEXT change has somewhere to go.
 *
 * Durability is unchanged and already good: writeJson() writes a temp file and renames,
 * and readJsonState() sets a corrupt file aside rather than letting a fallback overwrite
 * it. This adds the third case those two don't cover — a file from a NEWER Studio than
 * the one reading it, which is what a downgrade produces.
 */
import fs from 'fs';
import { readJsonState, writeJson } from './util.ts';
import type { Session } from './types.ts';

/**
 * The current on-disk shape. Bump when a change cannot be absorbed by tolerant reads,
 * and add the migration that carries the old shape forward.
 *
 * 0 → a bare `Session[]` with no envelope (every install predating this file)
 * 1 → `{ version, sessions }`, same session shape
 */
export const STATE_VERSION = 1;

/** What `loadSessions` found, before the manager indexes it. */
export interface LoadedState {
  sessions: Session[];
  /** The version as STORED — 0 for a bare array. Differs from STATE_VERSION when migrated. */
  version: number;
}

/** The file as written from STATE_VERSION 1 onward. */
export interface SessionsFile {
  version: number;
  sessions: Session[];
}

/**
 * Migrations from version N to N+1, indexed by N. `MIGRATIONS[0]` turns a pre-envelope
 * bare array into v1 — which needs no field changes, so it is identity, and that is the
 * honest content of this release rather than an invented conversion.
 *
 * A migration takes and returns the session array. It must be pure and total: it runs on
 * data written by an older version that cannot be consulted about what it meant.
 */
const MIGRATIONS: Array<(sessions: Session[]) => Session[]> = [
  // 0 → 1: the bare array becomes an enveloped one. The sessions themselves are unchanged.
  (sessions) => sessions,
];

/**
 * Keep a copy of a file whose shape this version is about to replace.
 *
 * Two cases, both about the next `_save()` writing OUR shape over what is there:
 *
 *  - NEWER than us (a downgrade). Guessing at fields a future version added is how
 *    state gets destroyed, so its file is kept before we can overwrite it.
 *  - version 0 (the upgrade every existing install makes). The upgrade is one-way: a
 *    Studio predating this module iterates the parsed file directly, so an envelope
 *    throws in its constructor. The copy is what makes a rollback a `cp`.
 */
function preserve(file: string, version: number): void {
  const aside = version === 0 ? `${file}.v0-pre-envelope` : `${file}.v${version}-newer`;
  try {
    if (!fs.existsSync(aside)) fs.copyFileSync(file, aside);
  } catch {
    /* best effort — a copy we could not make must not stop the daemon booting */
  }
}

/**
 * Read sessions.json, whatever shape it is in, and carry it forward to STATE_VERSION.
 *
 * A missing or empty file is a fresh install, not an error. A corrupt one is handled by
 * readJsonState(), which renames the original aside rather than letting the fallback
 * overwrite it — so returning no sessions here never destroys the evidence.
 */
export function loadSessions(file: string): LoadedState {
  const raw = readJsonState<Session[] | SessionsFile | null>(file, null);
  if (raw === null || raw === undefined) return { sessions: [], version: STATE_VERSION };

  // A bare array is the original, pre-envelope shape: version 0 by definition.
  if (Array.isArray(raw)) {
    // Keep the pre-envelope file, because the upgrade is ONE-WAY and nothing else
    // makes that survivable. A Studio predating this module reads sessions.json with
    // `for (const s of readJsonState<Session[]>(...))`, so an envelope is not merely
    // unrecognised — it is not iterable, and the SessionManager constructor throws
    // before the daemon can boot. Rolling back would otherwise mean hand-writing the
    // file that holds every claudeSessionId; with this it is one `cp`.
    preserve(file, 0);
    return { sessions: migrate(raw, 0), version: 0 };
  }

  const stored = Number.isFinite(raw.version) ? Number(raw.version) : 0;
  const sessions = Array.isArray(raw.sessions) ? raw.sessions : [];

  if (stored > STATE_VERSION) {
    // Written by a newer Studio. The sessions are probably readable — the shape only ever
    // grows — so load them, but keep their file first: our next save writes OUR shape.
    preserve(file, stored);
    return { sessions, version: stored };
  }
  return { sessions: migrate(sessions, stored), version: stored };
}

/** Run every migration between `from` and STATE_VERSION, in order. */
function migrate(sessions: Session[], from: number): Session[] {
  let out = sessions;
  for (let v = Math.max(0, from); v < STATE_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (step) out = step(out);
  }
  return out;
}

/** Write the envelope. Atomic (temp + rename) via writeJson, as this file has always been. */
export function saveSessions(file: string, sessions: Session[]): void {
  const payload: SessionsFile = { version: STATE_VERSION, sessions };
  writeJson(file, payload);
}
