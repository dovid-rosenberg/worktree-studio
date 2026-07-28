#!/usr/bin/env node
// node-pty ships prebuilt `spawn-helper` binaries without the execute bit on
// macOS, which makes pty.spawn fail with "posix_spawnp failed". Restore +x.
// Runs on postinstall so it survives future `npm install`s.
import fs from 'fs';
import path from 'path';

const base = path.join(import.meta.dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
let fixed = 0;
try {
  for (const dir of fs.readdirSync(base)) {
    const helper = path.join(base, dir, 'spawn-helper');
    if (fs.existsSync(helper)) {
      fs.chmodSync(helper, 0o755);
      fixed++;
    }
  }
} catch (e) {
  // node-pty layout may differ across versions; also try the build output.
}
try {
  const built = path.join(import.meta.dirname, '..', 'node_modules', 'node-pty', 'build', 'Release', 'spawn-helper');
  if (fs.existsSync(built)) { fs.chmodSync(built, 0o755); fixed++; }
} catch (e) { /* ignore */ }

console.log(`[fix-pty] made ${fixed} spawn-helper binary(ies) executable`);
