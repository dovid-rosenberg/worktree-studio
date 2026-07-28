'use strict';
// GitHub issues via the `gh` CLI (uses your existing gh auth; no token config).
const { run, has } = require('../util');

const ENV = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` };

module.exports = {
  id: 'github',
  label: 'GitHub',
  needsRepo: true,
  isEnabled(cfg) {
    return (cfg.sources && cfg.sources.github && cfg.sources.github.enabled !== false) && has('gh');
  },
  async list(cfg, { repoPath, q }) {
    if (!repoPath) return [];
    const args = ['issue', 'list', '--json', 'number,title,url,labels', '--limit', '30'];
    // `q` reaches an execFile argv, and it comes from `req.query.q` — which express
    // parses to an ARRAY for `?q=a&q=b`. execFile rejects a non-string arg with a
    // TypeError, i.e. a 500 leaking an internal message for what is just a malformed
    // request. Coerce; `--search` wants one string either way.
    if (q) { args.push('--search', String(q)); }
    const r = await run('gh', args, { cwd: repoPath, env: ENV });
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'gh issue list failed');
    const items = JSON.parse(r.stdout || '[]');
    return items.map((it) => ({
      id: String(it.number),
      title: it.title,
      subtitle: `#${it.number}` + (it.labels && it.labels.length ? ` · ${it.labels.map((l) => l.name).join(', ')}` : ''),
    }));
  },
  async seed(cfg, { repoPath, id }) {
    const r = await run('gh', ['issue', 'view', String(id), '--json', 'number,title,body,url'], { cwd: repoPath, env: ENV });
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'gh issue view failed');
    const it = JSON.parse(r.stdout);
    return { source: 'github', id: String(it.number), title: it.title, body: it.body || '', url: it.url };
  },
};
