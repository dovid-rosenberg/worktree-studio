/*
 * Run configurations, discovered from the worktree rather than imported into config.
 *
 * WHY DISCOVERED, NOT IMPORTED. The predecessor (worktree-dash) imported these into its
 * config file once and let you delete them by hand. That snapshot goes stale the moment
 * you edit the config in your editor, and it needs storage, merge/dedup and a delete UI
 * to maintain the copy. Reading the file is strictly less machinery AND cannot drift —
 * and the files are already in every worktree, because `copyAlways` copies
 * `.idea/runConfigurations/*.xml` at creation. Nothing to locate, nothing to refresh.
 *
 * `config.runConfigs[repo]` still exists and still works: that is the MANUAL half, for
 * anything no editor config expresses.
 *
 * UNKNOWN TYPES ARE SKIPPED, NEVER GUESSED. A run configuration is a command that will be
 * executed; inferring one from a shape this file does not understand is how you run the
 * wrong thing. Everything below either recognises a format exactly or ignores it.
 */
import fs from 'fs';
import path from 'path';

export type RunKind = 'server' | 'task';

export interface DiscoveredConfig {
  name: string;
  /** A shell command line, with editor placeholders already resolved. */
  cmd: string;
  /**
   * `server` is long-lived and gets tracked like a dev server (ports, Stop stack);
   * `task` is finite and runs in a terminal tab where you watch it.
   */
  kind: RunKind;
  env?: Record<string, string>;
  source: 'jetbrains' | 'vscode';
  /** The file it came from — shown as the tooltip, so a surprising command is traceable. */
  file: string;
}

/*
 * Which configs are long-lived.
 *
 * A heuristic, and deliberately a narrow one: it decides whether something is tracked as
 * a server or watched in a tab, and being wrong in the "server" direction leaves a
 * finished process looking like a crash. Anything not matching is a task, which is the
 * safe default — a long-lived process in a tab is merely inconvenient.
 */
const SERVER_NAME = /^(start|dev|serve|watch|run)\b|(^|[^a-z])(server|daemon)([^a-z]|$)/i;

/**
 * A command that IS the repo's configured start command is a server, whatever it is
 * called.
 *
 * This beats the name heuristic outright, and it fixes the case that motivated it: a
 * JetBrains config named "Launch Program" running `node app.js` is the backend, but no
 * name pattern would ever say so. `config.start[repo].cmd` already records exactly that
 * command, so the answer is available rather than guessable.
 *
 * Compared with the worktree path folded out, since a discovered command carries absolute
 * paths and a configured one does not.
 */
/**
 * THE decision: is this configuration a long-lived server, or a finite job?
 *
 * It routes the command into two completely different subsystems — Servers (a concurrency
 * slot, a port pre-check, a tracked pid, reachable by "Stop stack") or Runner (a run with
 * an exit code, shown in the Runs panel). Getting it wrong for a server means a dev server
 * that no Stop can reach and a Runs row that never finishes.
 *
 * It was once decided a different way in every parser: one hardcoded 'task', one tested
 * the name but not the command, one tested the command but not the name, one never called
 * matchesStartCmd at all — and discover() did not even PASS startCmd to some of them, so
 * those could not have applied the rule if they had tried. So the exact case this exists
 * for (a VS Code task whose command IS `config.start[repo].cmd`) was classified 'task',
 * while the identical command in a JetBrains XML was a server.
 *
 * One function now, with every signal the callers had between them:
 *   - an explicit declaration from the editor (VS Code's `isBackground`) wins outright;
 *   - then the configured start command, which is knowledge rather than a guess;
 *   - then the name/command heuristic, which is the fallback it always was.
 */
function isServer(opts: {
  cmd: string;
  name: string;
  worktreePath: string;
  startCmd?: string;
  /** The editor said so itself — VS Code's `isBackground`. `undefined` = it did not say. */
  declared?: boolean;
  /** An npm script name or task label, when it differs from the display name. */
  script?: string;
}): boolean {
  if (opts.declared !== undefined) return opts.declared;
  if (matchesStartCmd(opts.cmd, opts.worktreePath, opts.startCmd)) return true;
  return SERVER_NAME.test(opts.script || opts.name) || SERVER_NAME.test(opts.cmd);
}

function matchesStartCmd(cmd: string, worktreePath: string, startCmd?: string): boolean {
  if (!startCmd) return false;
  const norm = (s: string) =>
    s
      .replaceAll(worktreePath + path.sep, '')
      .replaceAll(worktreePath, '')
      .replaceAll("'", '')
      .replaceAll('"', '')
      .replace(/\s+/g, ' ')
      .trim();
  return norm(cmd) === norm(startCmd);
}

/** Editor placeholders for "the project root". */
function resolvePlaceholders(s: string, worktreePath: string): string {
  return s
    .replaceAll('$PROJECT_DIR$', worktreePath)
    .replaceAll('${workspaceFolder}', worktreePath)
    .replaceAll('${workspaceRoot}', worktreePath)
    .replaceAll('$ProjectFileDir$', worktreePath);
}

/**
 * JSON with comments and trailing commas — what VS Code actually writes.
 *
 * `JSON.parse` rejects both, and every one of the user's real `.vscode/launch.json`
 * files opens with three comment lines. Returns null rather than throwing: a config file
 * someone hand-broke should cost that file, not the whole discovery.
 */
export function parseJsonc<T>(text: string): T | null {
  // Strings first, so a `//` or `/* */` INSIDE one is never treated as a comment.
  const stripped = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n\r]*|\/\*[\s\S]*?\*\//g, (_m, str) => str || '');
  const noTrailingCommas = stripped.replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(noTrailingCommas) as T;
  } catch {
    return null;
  }
}

/** One `<tag value="…"/>` or `<tag>…</tag>` from a JetBrains configuration block. */
function xmlValue(block: string, tag: string): string {
  const attr = block.match(new RegExp(`<${tag}\\b[^>]*\\bvalue="([^"]*)"`));
  if (attr) return attr[1];
  const text = block.match(new RegExp(`<${tag}\\b[^>]*>([^<]*)</${tag}>`));
  return text ? text[1].trim() : '';
}

function xmlEnvs(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/<env\s+name="([^"]*)"\s+value="([^"]*)"\s*\/>/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

/** Shell-quote a single argument. */
const q = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * Where a package's executable actually is.
 *
 * NOT a guessed filename. This used to hardcode `bin/mocha.js`, which is mocha 9+; the
 * repo it was built against runs mocha 8, whose bin is `bin/mocha` with no extension. The
 * command it produced could not be resolved at all — "Cannot find module …/bin/mocha.js" —
 * while the same configuration ran fine in WebStorm, which does not guess.
 *
 * The `.bin` shim is checked first because that is the canonical entry point: npm writes
 * it, it points at whatever the package declares in its own `bin` field, and it is
 * therefore correct across versions that move the file around. The explicit names are a
 * fallback for a tree with no `.bin`.
 */
function resolveBin(pkgDir: string, binName: string, exists: (p: string) => boolean): string {
  // node_modules/<pkg>  →  node_modules/.bin/<name>
  const shim = path.join(path.dirname(pkgDir), '.bin', binName);
  if (exists(shim)) return shim;
  for (const candidate of [`bin/${binName}.js`, `bin/${binName}`, `bin/_${binName}`]) {
    const full = path.join(pkgDir, candidate);
    if (exists(full)) return full;
  }
  return '';
}

/**
 * One JetBrains `.idea/runConfigurations/*.xml`.
 *
 * Two types cover every config in practice (and all six of the ones this was built
 * against): an npm script, and a mocha run. A third — a plain Node file — is cheap to
 * add. Anything else returns null and is skipped.
 */
export function parseJetBrains(
  xml: string,
  worktreePath: string,
  file: string,
  opts: { startCmd?: string; exists?: (p: string) => boolean } = {},
): DiscoveredConfig | null {
  const { startCmd, exists = (p: string) => fs.existsSync(p) } = opts;
  const cfg = xml.match(/<configuration\b[^>]*>[\s\S]*?<\/configuration>/);
  if (!cfg) return null;
  const block = cfg[0];
  const name = (block.match(/<configuration\b[^>]*\bname="([^"]*)"/) || [])[1];
  const type = (block.match(/<configuration\b[^>]*\btype="([^"]*)"/) || [])[1];
  if (!name || !type) return null;

  const env = xmlEnvs(block);
  const base = { name, env: Object.keys(env).length ? env : undefined, source: 'jetbrains' as const, file };

  if (type === 'js.build_tools.npm') {
    const command = xmlValue(block, 'command') || 'run';
    const script = (block.match(/<script\s+value="([^"]*)"/) || [])[1];
    const cmd = script ? `npm ${command} ${script}` : `npm ${command}`;
    return {
      ...base,
      cmd,
      kind: isServer({ cmd, name, script, worktreePath, startCmd }) ? 'server' : 'task',
    };
  }

  if (type === 'mocha-javascript-test-runner') {
    const pkg = resolvePlaceholders(
      xmlValue(block, 'mocha-package') || path.join(worktreePath, 'node_modules', 'mocha'),
      worktreePath,
    );
    const bin = resolveBin(pkg, 'mocha', exists);
    const extra = xmlValue(block, 'extra-mocha-options');
    const pattern = xmlValue(block, 'test-pattern');
    /*
     * `npx --no-install` when nothing resolved: it looks in node_modules/.bin from the
     * cwd upwards, which is where a worktree without its own install finds the parent
     * checkout's copy — and `--no-install` means a genuinely missing mocha fails loudly
     * instead of silently downloading one.
     */
    const parts = bin ? [`node ${q(bin)}`] : ['npx --no-install mocha'];
    if (extra) parts.push(extra); // already a command-line fragment, verbatim
    if (pattern) parts.push(q(pattern));
    // A test run is finite by definition.
    return { ...base, cmd: parts.join(' '), kind: 'task' };
  }

  if (type === 'NodeJSConfigurationType') {
    const js = resolvePlaceholders(xmlValue(block, 'path-to-js-file'), worktreePath);
    if (!js) return null;
    const args = resolvePlaceholders(xmlValue(block, 'application-parameters'), worktreePath);
    const cmd = `node ${q(js)}${args ? ` ${args}` : ''}`;
    return { ...base, cmd, kind: isServer({ cmd, name, worktreePath, startCmd }) ? 'server' : 'task' };
  }

  return null; // an unrecognised type is skipped, not guessed at
}

interface VsCodeTask {
  label?: string;
  type?: string;
  command?: string;
  script?: string;
  args?: string[];
  isBackground?: boolean;
  options?: { env?: Record<string, string> };
}
interface VsCodeLaunch {
  name?: string;
  type?: string;
  request?: string;
  command?: string;
  program?: string;
  args?: string[];
  env?: Record<string, string>;
}

/** `.vscode/tasks.json` — `type: shell | process | npm`. */
export function parseVsCodeTasks(
  text: string,
  worktreePath: string,
  file: string,
  // Was absent, so this parser could not apply the configured-start-command rule even in
  // principle — the exact case isServer() exists for was unreachable from here.
  startCmd?: string,
): DiscoveredConfig[] {
  const doc = parseJsonc<{ tasks?: VsCodeTask[] }>(text);
  const out: DiscoveredConfig[] = [];
  for (const t of doc?.tasks || []) {
    const name = t.label;
    if (!name) continue;
    let cmd = '';
    if (t.type === 'npm' && t.script) cmd = `npm run ${t.script}`;
    else if (t.command) cmd = [t.command, ...(t.args || [])].join(' ');
    if (!cmd) continue;
    out.push({
      name,
      cmd: resolvePlaceholders(cmd, worktreePath),
      // `isBackground` is VS Code's own word for "this does not finish" — believe it
      // over the name when it is present.
      kind: isServer({
        cmd,
        name,
        script: t.script,
        worktreePath,
        startCmd,
        declared: t.isBackground,
      })
        ? 'server'
        : 'task',
      env: t.options?.env,
      source: 'vscode',
      file,
    });
  }
  return out;
}

/** `.vscode/launch.json` — only the entries that name a command we can actually run. */
export function parseVsCodeLaunch(
  text: string,
  worktreePath: string,
  file: string,
  startCmd?: string,
): DiscoveredConfig[] {
  const doc = parseJsonc<{ configurations?: VsCodeLaunch[] }>(text);
  const out: DiscoveredConfig[] = [];
  for (const c of doc?.configurations || []) {
    const name = c.name;
    if (!name) continue;
    let cmd = '';
    // `node-terminal` carries a literal shell command, which is the only launch kind that
    // maps cleanly. `node` + program is a file to run.
    if (c.type === 'node-terminal' && c.command) cmd = c.command;
    else if (c.type === 'node' && c.program)
      cmd = `node ${q(resolvePlaceholders(c.program, worktreePath))}${(c.args || []).length ? ` ${(c.args || []).join(' ')}` : ''}`;
    // Everything else (extensionHost, chrome, attach…) is a debugger session, not a
    // command — skipped rather than approximated.
    if (!cmd) continue;
    out.push({
      name,
      cmd: resolvePlaceholders(cmd, worktreePath),
      kind: isServer({ cmd, name, worktreePath, startCmd }) ? 'server' : 'task',
      env: c.env,
      source: 'vscode',
      file,
    });
  }
  return out;
}

const read = (f: string): string | null => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};

/**
 * Every run configuration this worktree declares, from every editor it declares them in.
 *
 * Deduped by name, first source winning in the order JetBrains → VS Code. Two editors
 * describing the same script should be one entry, and a stable order beats a merge
 * nobody asked for.
 */
export async function discover(
  worktreePath: string,
  opts: { startCmd?: string } = {},
): Promise<DiscoveredConfig[]> {
  const out: DiscoveredConfig[] = [];

  const ideaDir = path.join(worktreePath, '.idea', 'runConfigurations');
  let ideaFiles: string[] = [];
  try {
    ideaFiles = fs.readdirSync(ideaDir).filter((f) => f.endsWith('.xml'));
  } catch {
    /* none */
  }
  for (const f of ideaFiles.sort()) {
    const full = path.join(ideaDir, f);
    const xml = read(full);
    if (!xml) continue;
    const parsed = parseJetBrains(xml, worktreePath, full, { startCmd: opts.startCmd });
    if (parsed) out.push(parsed);
  }

  const tasks = path.join(worktreePath, '.vscode', 'tasks.json');
  const tasksText = read(tasks);
  if (tasksText) out.push(...parseVsCodeTasks(tasksText, worktreePath, tasks, opts.startCmd));

  const launch = path.join(worktreePath, '.vscode', 'launch.json');
  const launchText = read(launch);
  if (launchText) out.push(...parseVsCodeLaunch(launchText, worktreePath, launch, opts.startCmd));

  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
}
