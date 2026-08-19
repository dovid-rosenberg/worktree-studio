#!/usr/bin/env node
// Build the SvelteKit frontend the daemon serves (client/ → client/build).
//
// client/ is a separate npm project on purpose: its toolchain (vite, svelte, adapter-
// static) is a build-time concern and has no business in the daemon's dependency tree,
// which is deliberately five packages. So this installs there if it has to, then builds.
//
// Wired into the root `postinstall`, which is the one moment the network is already
// assumed. `npm start` stays `node server/server.ts` — no build step, no install check,
// nothing that can fail offline. The trade is that the build does NOT track edits to
// client/src: rerun `npm run build` after changing the frontend, or use `cd client &&
// npm run dev` (which is what that loop is for). server/webui.ts refuses to boot with a
// missing build and says which command produces it, so a stale-vs-absent build is never
// silently a blank page.
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const client = path.join(import.meta.dirname, '..', 'client');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function npmRun(args: string[]): void {
  const r = spawnSync(npm, args, { cwd: client, stdio: 'inherit' });
  if (r.error) {
    console.error(`[build-client] ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status || 1);
}

if (!fs.existsSync(path.join(client, 'node_modules'))) {
  /*
   * `ci` when there is a lockfile, `install` only when there is not.
   *
   * This always ran `install`, which resolves dependencies freely — so a release
   * built its bundle from whatever npm chose at that moment, and the workflow's
   * later `npm ci --prefix client` reinstalled the locked tree over the top without
   * rebuilding. The shipped bundle and the lockfile described different dependency
   * sets, in the one workflow whose stated purpose is making a version reproducible.
   */
  const locked = fs.existsSync(path.join(client, 'package-lock.json'));
  console.log(`[build-client] client/node_modules missing — running npm ${locked ? 'ci' : 'install'}`);
  npmRun([locked ? 'ci' : 'install', '--no-audit', '--no-fund']);
}
npmRun(['run', 'build']);
console.log(`[build-client] built → ${path.join(client, 'build')}`);
