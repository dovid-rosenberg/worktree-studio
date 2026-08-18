/*
 * Coercing a settings request body into config shapes.
 *
 * `POST /settings` is a FULL REPLACE for each of these maps: whatever the body carries
 * becomes the whole thing. That is the intended contract — a row deleted in the modal is
 * deleted on disk — and it is what makes these functions load-bearing, because anything
 * they drop is DESTROYED rather than merely ignored.
 *
 * They live here, apart from the route, for exactly that reason: the bug they exist to
 * prevent was a shape the coercion did not recognise being silently deleted, and a pure
 * function is something a test can hold still and enumerate the shapes of.
 */
import type { EditorConfig, GroupConfig, RunConfig } from './types.ts';

/**
 * What a coerced `start` entry is.
 *
 * `StartConfig` is the union of the two shapes valid ON DISK; this is narrower on
 * purpose, because coercion normalises: whatever went in, what comes out is always the
 * object form. Saying so is what lets a caller read `.cmd` without re-checking.
 */
export interface NormalisedStart {
  cmd: string;
  ports: number[];
}

/** A plain object, as opposed to null or an array. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * A URL a browser may be pointed at from inside the app.
 *
 * Only absolute http and https. Everything the UI does with a stored link ends in an
 * `href`, in a page that holds the boot token — so `javascript:` is not an exotic input
 * to guard against, it is the whole attack: one click on a pinned link and the token is
 * in someone else's query string. `data:` and `file:` are refused for the same reason.
 *
 * Scheme-less values ("example.com") are refused rather than helpfully prefixed. Guessing
 * turns a typo into a link to somewhere real, and the caller who typed it is right here
 * to be told.
 */
export function isFollowable(url: string): boolean {
  try {
    const p = new URL(url).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

/** `[1231, 1999]`, `"1231 1999"` and `"1231,1999"` all mean the same thing. */
export function coercePorts(v: unknown): number[] {
  return (Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\s,]+/))
    .map((x) => Number.parseInt(String(x), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * `start`: `{ "<repo>": { cmd, ports } }`, normalised.
 *
 * TWO SHAPES ARE VALID ON DISK. `"repo": "npm start"` is the documented shorthand and is
 * what `servers.startCfg()` reads everywhere else. This used to test `isRecord(v)` first,
 * so a string produced an empty command and — because the map is replaced wholesale — the
 * entry was DELETED. Opening the settings modal and pressing Save silently un-configured
 * every repo written that way, and the only symptom was "no start command configured for
 * this repo" the next time you ran the stack.
 *
 * A string is normalised to the object form on the way through, so an entry saved once
 * round-trips safely from then on.
 */
export function coerceStart(v: unknown): Record<string, NormalisedStart> {
  const out: Record<string, NormalisedStart> = {};
  if (!isRecord(v)) return out;
  for (const [repo, entry] of Object.entries(v)) {
    const name = String(repo).trim();
    const cmd = (typeof entry === 'string' ? entry : isRecord(entry) ? String(entry.cmd || '') : '').trim();
    // An entry with no command is not launchable — dropping it is the intended replace.
    if (!name || !cmd) continue;
    out[name] = { cmd, ports: coercePorts(isRecord(entry) ? entry.ports : undefined) };
  }
  return out;
}

/** `editors`: `{ "<name>": { open, openGroup? } }`. An entry with no `open` cannot open anything. */
export function coerceEditors(v: unknown): Record<string, EditorConfig> {
  const out: Record<string, EditorConfig> = {};
  if (!isRecord(v)) return out;
  for (const [name, entry] of Object.entries(v)) {
    const key = String(name).trim();
    if (!key || !isRecord(entry)) continue;
    const open = String(entry.open || '').trim();
    if (!open) continue;
    const openGroup = String(entry.openGroup || '').trim();
    out[key] = openGroup ? { open, openGroup } : { open };
  }
  return out;
}

/** `groups`: `[{ name, members }]`. A group with no members groups nothing. */
export function coerceGroups(v: unknown): GroupConfig[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isRecord)
    .map((g) => ({
      name: String(g.name || '').trim(),
      members: (Array.isArray(g.members) ? g.members : []).map((m) => String(m).trim()).filter(Boolean),
    }))
    .filter((g) => g.name && g.members.length);
}

/**
 * `runConfigs`: `{ "<repo>": [{ name, cmd, kind }] }` — the MANUAL half only.
 *
 * Whatever an editor declares in a worktree is discovered live (server/run-configs.ts) and
 * never stored, so replacing this map cannot delete a configuration that came from a file.
 */
export function coerceRunConfigs(v: unknown): Record<string, RunConfig[]> {
  const out: Record<string, RunConfig[]> = {};
  if (!isRecord(v)) return out;
  for (const [repo, list] of Object.entries(v)) {
    const name = String(repo).trim();
    if (!name || !Array.isArray(list)) continue;
    const rows = list
      .filter(isRecord)
      .map((c) => ({
        name: String(c.name || '').trim(),
        cmd: String(c.cmd || '').trim(),
        kind: c.kind === 'server' ? 'server' : 'task',
        source: 'manual',
      }))
      .filter((c) => c.name && c.cmd);
    if (rows.length) out[name] = rows;
  }
  return out;
}

/**
 * Add (or replace) one manual feature group, without touching the others.
 *
 * Everything else in this file is a FULL REPLACE — the settings modal owns the whole
 * map. This is the opposite, and deliberately so: it exists for the drift banner, where
 * the user is answering one question ("these two are the same feature") and has said
 * nothing at all about their other groups. A full replace driven by a payload built from
 * one card would delete every group the user had made by hand.
 *
 * Replace-by-name rather than append-always, so answering the same question twice does
 * not leave two groups fighting over one name — computeFeatures() keys manual groups by
 * name and would silently show only one of them.
 *
 * Returns a NEW array. The caller assigns it to `cfg.groups` and saves; keeping this
 * pure is what lets a test enumerate the cases without a config file.
 */
export function upsertGroup(groups: GroupConfig[] | undefined, group: GroupConfig): GroupConfig[] {
  const [clean] = coerceGroups([group]);
  if (!clean) return coerceGroups(groups); // no name, or no members — nothing to add
  const rest = coerceGroups(groups).filter((g) => g.name !== clean.name);
  return [...rest, clean];
}
