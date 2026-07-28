#!/usr/bin/env node
// Copy xterm's browser bundles out of node_modules into public/vendor so the
// frontend can load them with plain <script>/<link> tags (no bundler).
import fs from 'fs';
import path from 'path';

const root = path.join(import.meta.dirname, '..');
const out = path.join(root, 'public', 'vendor');
fs.mkdirSync(out, { recursive: true });

const files = [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
  ['@xterm/addon-web-links/lib/addon-web-links.js', 'addon-web-links.js'],
];

let copied = 0;
for (const [from, to] of files) {
  const src = path.join(root, 'node_modules', from);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(out, to));
    copied++;
  } else {
    console.warn(`[vendor] missing ${from} — run npm install`);
  }
}
console.log(`[vendor] copied ${copied} xterm asset(s) to public/vendor`);
