// GitLab issues. Prefers the `glab` CLI when installed; otherwise falls back to
// the REST API using a configured token + project path.
import { run, has } from '../util.js';

const ENV = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` };

function cfgOf(cfg) { return (cfg.sources && cfg.sources.gitlab) || {}; }

/** @returns {Promise<any>} decoded GitLab JSON — shape varies by endpoint */
async function rest(cfg, pathAndQuery) {
  const g = cfgOf(cfg);
  const host = (g.host || 'https://gitlab.com').replace(/\/$/, '');
  const res = await fetch(`${host}/api/v4${pathAndQuery}`, { headers: { 'PRIVATE-TOKEN': g.token } });
  if (!res.ok) throw new Error(`GitLab API ${res.status}`);
  return res.json();
}

export default {
  id: 'gitlab',
  label: 'GitLab',
  needsRepo: true,
  isEnabled(cfg) {
    const g = cfgOf(cfg);
    if (!g.enabled) return false;
    return has('glab') || (!!g.token && !!g.project);
  },
  async list(cfg, { repoPath, q }) {
    const g = cfgOf(cfg);
    if (has('glab') && repoPath) {
      const args = ['issue', 'list', '-P', '30', '-F', 'json'];
      const r = await run('glab', args, { cwd: repoPath, env: ENV });
      if (r.code !== 0) throw new Error(r.stderr.trim() || 'glab issue list failed');
      const items = JSON.parse(r.stdout || '[]');
      return items.map((it) => ({ id: String(it.iid), title: it.title, subtitle: `!${it.iid}` }));
    }
    const proj = encodeURIComponent(g.project);
    const items = await rest(cfg, `/projects/${proj}/issues?state=opened&per_page=30${q ? `&search=${encodeURIComponent(q)}` : ''}`);
    return items.map((it) => ({ id: String(it.iid), title: it.title, subtitle: `#${it.iid}` }));
  },
  async seed(cfg, { repoPath, id }) {
    const g = cfgOf(cfg);
    if (has('glab') && repoPath) {
      const r = await run('glab', ['issue', 'view', String(id), '-F', 'json'], { cwd: repoPath, env: ENV });
      if (r.code !== 0) throw new Error(r.stderr.trim() || 'glab issue view failed');
      const it = JSON.parse(r.stdout);
      return { source: 'gitlab', id: String(it.iid), title: it.title, body: it.description || '', url: it.web_url };
    }
    const proj = encodeURIComponent(g.project);
    const it = await rest(cfg, `/projects/${proj}/issues/${id}`);
    return { source: 'gitlab', id: String(it.iid), title: it.title, body: it.description || '', url: it.web_url };
  },
};
