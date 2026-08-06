// Parsing editor run configurations out of a worktree.
//
// These produce COMMANDS THAT WILL BE EXECUTED, so the tests care about two things above
// all: that a recognised format is turned into the right command line, and that an
// unrecognised one is skipped rather than approximated.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  discover,
  parseJetBrains,
  parseJsonc,
  parseVsCodeLaunch,
  parseVsCodeTasks,
  parseZed,
} from '../server/run-configs.ts';

const wt = '/code/api/.worktrees/feat';

const jb = (inner: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<component name="ProjectRunConfigurationManager">\n${inner}\n</component>`;

test('an npm script becomes `npm run <script>`', () => {
  const c = parseJetBrains(
    jb(`<configuration name="test:unit" type="js.build_tools.npm">
      <package-json value="$PROJECT_DIR$/package.json" />
      <command value="run" /><scripts><script value="test:unit" /></scripts>
    </configuration>`),
    wt,
    'f.xml',
  );
  assert.equal(c?.cmd, 'npm run test:unit');
  assert.equal(c?.kind, 'task', 'a test script is finite');
});

test('a script named start is a server, so it gets tracked rather than watched', () => {
  const c = parseJetBrains(
    jb(`<configuration name="Start Debug" type="js.build_tools.npm">
      <command value="run" /><scripts><script value="start" /></scripts>
    </configuration>`),
    wt,
    'f.xml',
  );
  assert.equal(c?.kind, 'server');
});

test("a config matching the repo's configured start command is a server whatever its name", () => {
  /*
   * The case the name heuristic could never get: a JetBrains config called "Launch
   * Program" that runs `node app.js` IS the backend. `config.start[repo].cmd` already
   * records that command, so it is known rather than guessable.
   */
  const xml = jb(`<configuration name="Launch Program" type="NodeJSConfigurationType">
      <path-to-js-file value="$PROJECT_DIR$/app.js" />
    </configuration>`);
  assert.equal(parseJetBrains(xml, wt, 'f.xml')?.kind, 'task', 'without the hint, the name says nothing');
  assert.equal(parseJetBrains(xml, wt, 'f.xml', 'node app.js')?.kind, 'server', 'with it, it is the server');
});

test('a mocha config becomes a runnable command, with its envs', () => {
  const c = parseJetBrains(
    jb(`<configuration name="Integration tests" type="mocha-javascript-test-runner">
      <mocha-package>$PROJECT_DIR$/node_modules/mocha</mocha-package>
      <envs><env name="NODE_ENV" value="test" /></envs>
      <extra-mocha-options>--config test/.mocharc.js</extra-mocha-options>
      <test-pattern>test/**/*.spec.js</test-pattern>
    </configuration>`),
    wt,
    'f.xml',
  );
  assert.match(c?.cmd || '', /node '.*node_modules\/mocha\/bin\/mocha\.js'/);
  assert.match(c?.cmd || '', /--config test\/\.mocharc\.js/);
  assert.match(
    c?.cmd || '',
    /'test\/\*\*\/\*\.spec\.js'/,
    'the glob is quoted so the shell cannot expand it',
  );
  assert.deepEqual(c?.env, { NODE_ENV: 'test' });
  assert.equal(c?.kind, 'task');
});

test('an UNRECOGNISED type is skipped, never approximated', () => {
  // The important refusal: this produces a command that gets executed.
  const c = parseJetBrains(
    jb(
      `<configuration name="Remote Debug" type="RemoteDebugConfigurationType"><host value="x" /></configuration>`,
    ),
    wt,
    'f.xml',
  );
  assert.equal(c, null);
});

test('$PROJECT_DIR$ resolves to the worktree, not the repo it was copied from', () => {
  const c = parseJetBrains(
    jb(`<configuration name="app" type="NodeJSConfigurationType">
      <path-to-js-file value="$PROJECT_DIR$/app.js" />
    </configuration>`),
    wt,
    'f.xml',
  );
  assert.ok(c?.cmd.includes(`${wt}/app.js`), `expected the worktree path: ${c?.cmd}`);
});

test('parseJsonc survives the comments and trailing commas editors actually write', () => {
  const doc = parseJsonc<{ a: number; b: string }>(`{
    // a line comment
    "a": 1, /* and a block one */
    "b": "http://not-a-comment",
  }`);
  assert.deepEqual(doc, { a: 1, b: 'http://not-a-comment' });
});

test('parseJsonc ignores // inside a string rather than truncating the file', () => {
  const doc = parseJsonc<{ url: string }>('{"url": "https://example.com/x"}');
  assert.deepEqual(doc, { url: 'https://example.com/x' });
});

test('a broken config file costs that file, not the whole discovery', () => {
  assert.equal(parseJsonc('{ nope'), null);
});

test('VS Code tasks: npm and shell, with isBackground believed over the name', () => {
  const out = parseVsCodeTasks(
    JSON.stringify({
      tasks: [
        { label: 'unit', type: 'npm', script: 'test:unit' },
        { label: 'tail logs', type: 'shell', command: 'tail', args: ['-f', 'app.log'], isBackground: true },
      ],
    }),
    wt,
    'tasks.json',
  );
  assert.equal(out[0].cmd, 'npm run test:unit');
  assert.equal(out[0].kind, 'task');
  assert.equal(out[1].cmd, 'tail -f app.log');
  assert.equal(out[1].kind, 'server', 'isBackground is VS Code saying it does not finish');
});

test('VS Code launch: a runnable command is taken, a debugger session is not', () => {
  const out = parseVsCodeLaunch(
    JSON.stringify({
      configurations: [
        { name: 'Run npm start', type: 'node-terminal', command: 'npm start' },
        { name: 'Launch Extension', type: 'extensionHost', request: 'launch' },
        { name: 'Attach', type: 'node', request: 'attach' },
      ],
    }),
    wt,
    'launch.json',
  );
  assert.equal(out.length, 1, 'only the one that names a command');
  assert.equal(out[0].cmd, 'npm start');
  assert.equal(out[0].kind, 'server');
});

test('Zed tasks are a bare array of label + command', () => {
  const out = parseZed(
    JSON.stringify([{ label: 'lint', command: 'npm', args: ['run', 'lint'] }]),
    wt,
    'tasks.json',
  );
  assert.equal(out[0].cmd, 'npm run lint');
  assert.equal(out[0].kind, 'task');
});

test('discover reads every editor in one worktree and dedupes by name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-rc-'));
  fs.mkdirSync(path.join(dir, '.idea', 'runConfigurations'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.zed'), { recursive: true });

  fs.writeFileSync(
    path.join(dir, '.idea', 'runConfigurations', 'unit.xml'),
    jb(`<configuration name="unit" type="js.build_tools.npm">
      <command value="run" /><scripts><script value="test:unit" /></scripts>
    </configuration>`),
  );
  // Same NAME as the JetBrains one: the first source wins rather than both showing.
  fs.writeFileSync(
    path.join(dir, '.vscode', 'tasks.json'),
    '{ // written by an editor\n "tasks": [{ "label": "unit", "type": "npm", "script": "other" }] }',
  );
  fs.writeFileSync(
    path.join(dir, '.zed', 'tasks.json'),
    JSON.stringify([{ label: 'lint', command: 'npm run lint' }]),
  );

  const out = await discover(dir);
  assert.deepEqual(out.map((c) => c.name).sort(), ['lint', 'unit']);
  assert.equal(out.find((c) => c.name === 'unit')?.cmd, 'npm run test:unit', 'JetBrains won the name');
  assert.equal(out.find((c) => c.name === 'lint')?.source, 'zed');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a worktree with no editor configs discovers nothing, quietly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-rc-empty-'));
  assert.deepEqual(await discover(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
