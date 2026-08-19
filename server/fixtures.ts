/*
 * Fixtures mode: serve a frozen fleet instead of a real one.
 *
 * The daemon normally needs real repos, real worktrees, tmux and `gh` before it can show
 * anything at all. That makes the UI impossible to check deterministically — the fleet
 * moves while you look at it — and makes the states you most want to verify (every slot
 * blocked, a stuck orphan, a feature with no start command) unreachable on demand.
 *
 * `--fixtures <file.json>` replaces the one seam everything downstream reads: the state
 * payload. Nothing else in the daemon changes shape, which is the point — the routes,
 * the SSE frames and the client are the real ones, and only the world is fake.
 *
 * Capture your own with:
 *   curl -s -H "x-wts-token: $(cat ~/.local/state/worktree-studio/token)" \
 *     http://127.0.0.1:7788/api/v1/state > fleet.json
 */
import fs from 'fs';
import path from 'path';
import type { StatePayload } from './types.ts';

/** Parsed `--fixtures <file>`, or null. Accepts `--fixtures=<file>` too. */
export function fixturesFlag(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixtures') return argv[i + 1] ?? '';
    if (a.startsWith('--fixtures=')) return a.slice('--fixtures='.length);
  }
  return null;
}

/**
 * Read and sanity-check a fixture payload.
 *
 * Throws rather than falling back to a real scan: a typo in the path silently starting
 * the daemon against your actual fleet is the one outcome this mode must never produce,
 * because everything downstream would then be real while the banner said otherwise.
 */
export function loadFixtures(file: string): StatePayload {
  if (!file) throw new Error('--fixtures needs a file path');
  const full = path.resolve(file);
  let raw: string;
  try {
    raw = fs.readFileSync(full, 'utf8');
  } catch {
    throw new Error(`--fixtures: cannot read ${full}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`--fixtures: ${full} is not valid JSON — ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`--fixtures: ${full} must be a state payload object`);
  }
  const p = parsed as Partial<StatePayload>;
  if (!Array.isArray(p.repos) || !Array.isArray(p.features)) {
    throw new Error(`--fixtures: ${full} has no repos/features — it should be the body of GET /api/v1/state`);
  }
  return parsed as StatePayload;
}

/** A short line for the boot log, so a fixture daemon announces itself in the terminal too. */
export function describe(file: string, payload: StatePayload): string {
  const features = payload.features?.length ?? 0;
  const sessions = payload.sessions?.length ?? 0;
  return `FIXTURES: ${path.resolve(file)} (${features} feature(s), ${sessions} session(s))`;
}

/**
 * Refuse anything that would act on the machine.
 *
 * The banner tells the user nothing here is real; that has to be true, or the mode is
 * worse than no mode — a captured fixture fleet looks exactly like the fleet it was
 * captured from, and "start this stack" would happily start the real one.
 *
 * A refusal rather than a silent success: pretending an action worked would make the UI
 * lie in a second, subtler way, and a fixtures daemon is for reviewing what the UI SHOWS,
 * which every GET still answers honestly.
 */
export function refuseMutations(): (req: GuardedRequest, res: GuardedResponse, next: () => void) => void {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    res.status(409).json({
      ok: false,
      error: 'fixtures mode: this daemon serves a frozen fleet and executes nothing',
    });
  };
}

/** The two fields the guard reads, named so it can be tested without express. */
export interface GuardedRequest {
  method?: string;
}
export interface GuardedResponse {
  status(code: number): { json(body: unknown): unknown };
}
