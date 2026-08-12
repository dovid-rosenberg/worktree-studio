/*
 * Where Studio's files live, and how to reach its API. Side-effect-free.
 *
 * One convention, six copies. bin/wt-studio.ts re-derived the config path, the default
 * port and the token file for its `add-repo` call; swiftbar/wts-action.sh,
 * swiftbar/worktrees.10s.sh, alfred/src/action.sh and alfred/src/filter.sh each derive
 * the same three again with `jq`. Move the default port and only the daemon follows —
 * every surface that reaches it keeps talking to 7788.
 *
 * NOTHING here runs at import time: no file is read, no directory is created, nothing is
 * cached. That is a requirement, not tidiness — bin/wt-studio.ts imports this module on
 * the `add-repo` and `endpoint` paths, which must not be able to boot or seed anything,
 * and the boot path is a dynamic import for exactly the same reason.
 *
 * MUST AGREE WITH, and deliberately duplicates rather than imports:
 *   · server/config.ts — CONFIG_DIR / CONFIG_FILE / STATE_DIR and their env overrides,
 *     and `web.port: 7788` in defaults()
 *   · server/security.ts — the token file is `token` inside the state dir, mode 0600
 * Importing either would drag the whole config loader (and its first-run seeding) into a
 * CLI that only wants to know a port number. The duplication is the lesser evil, and it
 * is one file's worth instead of six.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

/** The environment a path is resolved against. Injectable so nothing has to mutate process.env. */
type Env = Record<string, string | undefined>;

/**
 * The port the daemon binds when config.json does not say.
 *
 * Must equal `web.port` in server/config.ts's defaults(). It is a constant here and a
 * default there because a CLI has no config object to consult and must not build one.
 */
export const DEFAULT_PORT = 7788;

/** The loopback host every one of these surfaces talks to. Studio never binds elsewhere. */
export const DEFAULT_HOST = '127.0.0.1';

/**
 * `$HOME` if the environment sets it, else the OS's answer.
 *
 * os.homedir() already prefers $HOME on POSIX, so this differs from config.ts only in
 * being resolvable against an environment the caller passes — which is what makes the
 * rules below testable without touching the real home directory.
 */
function home(env: Env): string {
  return env.HOME || os.homedir();
}

/** `~/.config/worktree-studio`, or `$WT_STUDIO_CONFIG_DIR`. */
export function configDir(env: Env = process.env): string {
  return env.WT_STUDIO_CONFIG_DIR || path.join(home(env), '.config', 'worktree-studio');
}

/**
 * config.json. `$WT_STUDIO_CONFIG` names the FILE, not the directory — it wins outright,
 * so pointing it somewhere else does not have to agree with $WT_STUDIO_CONFIG_DIR.
 */
export function configFile(env: Env = process.env): string {
  return env.WT_STUDIO_CONFIG || path.join(configDir(env), 'config.json');
}

/** `~/.local/state/worktree-studio`, or `$WT_STUDIO_STATE`. */
export function stateDir(env: Env = process.env): string {
  return env.WT_STUDIO_STATE || path.join(home(env), '.local', 'state', 'worktree-studio');
}

/**
 * The boot token file. In the STATE dir, not the config dir, and at mode 0600: being
 * able to read it is the proof that a caller is a process of the user who owns the
 * studio (see server/security.ts, which is what writes it).
 */
export function tokenFile(env: Env = process.env): string {
  return path.join(stateDir(env), 'token');
}

/**
 * The configured port, or the default.
 *
 * Total: an absent, unreadable or malformed config.json is a first run or a hand-edit in
 * progress, and a CLI that threw there would be reporting the wrong problem — the caller
 * finds out soon enough when the request is refused.
 */
export function readPort(env: Env = process.env): number {
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile(env), 'utf8')) as { web?: { port?: unknown } };
    const port = Number(cfg?.web?.port);
    return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

/** The boot token, or '' when there is none — which is what "the daemon is not running" looks like. */
export function readToken(env: Env = process.env): string {
  try {
    return fs.readFileSync(tokenFile(env), 'utf8').trim();
  } catch {
    return '';
  }
}

/** The API's origin, e.g. `http://127.0.0.1:7788`. No trailing slash; callers append a path. */
export function baseUrl(env: Env = process.env): string {
  return `http://${DEFAULT_HOST}:${readPort(env)}`;
}
