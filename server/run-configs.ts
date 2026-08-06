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
  source: 'jetbrains' | 'vscode' | 'zed';
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
 * JSON with comments and trailing commas — what VS Code and Zed actually write.
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
  startCmd?: string,
): DiscoveredConfig | null {
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
    const server = matchesStartCmd(cmd, worktreePath, startCmd) || SERVER_NAME.test(script || name);
    return { ...base, cmd, kind: server ? 'server' : 'task' };
  }

  if (type === 'mocha-javascript-test-runner') {
    const pkg = resolvePlaceholders(xmlValue(block, 'mocha-package') || 'node_modules/mocha', worktreePath);
    const extra = xmlValue(block, 'extra-mocha-options');
    const pattern = xmlValue(block, 'test-pattern');
    const parts = [path.join(pkg, 'bin', 'mocha.js')].map(q);
    if (extra) parts.push(extra); // already a command-line fragment, verbatim
    if (pattern) parts.push(q(pattern));
    // A test run is finite by definition.
    return { ...base, cmd: `node ${parts.join(' ')}`, kind: 'task' };
  }

  if (type === 'NodeJSConfigurationType') {
    const js = resolvePlaceholders(xmlValue(block, 'path-to-js-file'), worktreePath);
    if (!js) return null;
    const args = resolvePlaceholders(xmlValue(block, 'application-parameters'), worktreePath);
    const cmd = `node ${q(js)}${args ? ` ${args}` : ''}`;
    const server = matchesStartCmd(cmd, worktreePath, startCmd) || SERVER_NAME.test(name);
    return { ...base, cmd, kind: server ? 'server' : 'task' };
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
export function parseVsCodeTasks(text: string, worktreePath: string, file: string): DiscoveredConfig[] {
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
      kind: (t.isBackground ?? SERVER_NAME.test(t.script || name)) ? 'server' : 'task',
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
      kind:
        matchesStartCmd(cmd, worktreePath, startCmd) || SERVER_NAME.test(cmd) || SERVER_NAME.test(name)
          ? 'server'
          : 'task',
      env: c.env,
      source: 'vscode',
      file,
    });
  }
  return out;
}

interface ZedTask {
  label?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/** `.zed/tasks.json` — a bare array of `{label, command, args}`. */
export function parseZed(text: string, worktreePath: string, file: string): DiscoveredConfig[] {
  const doc = parseJsonc<ZedTask[]>(text);
  if (!Array.isArray(doc)) return [];
  const out: DiscoveredConfig[] = [];
  for (const t of doc) {
    if (!t?.label || !t.command) continue;
    const cmd = resolvePlaceholders([t.command, ...(t.args || [])].join(' '), worktreePath);
    out.push({
      name: t.label,
      cmd,
      kind: SERVER_NAME.test(t.label) ? 'server' : 'task',
      env: t.env,
      source: 'zed',
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
 * Deduped by name, first source winning in the order JetBrains → VS Code → Zed. Two
 * editors describing the same script should be one entry, and a stable order beats a
 * merge nobody asked for.
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
    const parsed = parseJetBrains(xml, worktreePath, full, opts.startCmd);
    if (parsed) out.push(parsed);
  }

  const tasks = path.join(worktreePath, '.vscode', 'tasks.json');
  const tasksText = read(tasks);
  if (tasksText) out.push(...parseVsCodeTasks(tasksText, worktreePath, tasks));

  const launch = path.join(worktreePath, '.vscode', 'launch.json');
  const launchText = read(launch);
  if (launchText) out.push(...parseVsCodeLaunch(launchText, worktreePath, launch, opts.startCmd));

  const zed = path.join(worktreePath, '.zed', 'tasks.json');
  const zedText = read(zed);
  if (zedText) out.push(...parseZed(zedText, worktreePath, zed));

  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
}
