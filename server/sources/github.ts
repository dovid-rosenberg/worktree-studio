// GitHub issues via the `gh` CLI (uses your existing gh auth; no token config).
import type { SourceAdapter } from '../types.ts';
import { CHILD_ENV, run, has } from '../util.ts';

const ENV = CHILD_ENV;

/** The issue fields the two `gh --json` calls below ask for, optional where the code guards. */
interface GithubIssue {
  number: number;
  title: string;
  url: string;
  body?: string;
  labels?: Array<{ name: string }>;
}

const adapter: SourceAdapter = {
  id: 'github',
  label: 'GitHub',
  needsRepo: true,
  isEnabled(cfg) {
    return !!(cfg.sources?.github && cfg.sources.github.enabled !== false) && has('gh');
  },
  async list(_cfg, { repoPath, q }) {
    if (!repoPath) return [];
    /*
     * `--assignee @me`, matching the Asana adapter.
     *
     * This listed every open issue in the repo while asana.list() used `assignee=me`, so
     * the same picker meant "my tasks" for one source and "all issues" for another. A
     * token is user-scoped in every one of these APIs, so "mine" is the answerable
     * question and the one the picker is for.
     */
    const args = ['issue', 'list', '--assignee', '@me', '--json', 'number,title,url,labels', '--limit', '30'];
    // `q` reaches an execFile argv, and it comes from `req.query.q` — which express
    // parses to an ARRAY for `?q=a&q=b`. execFile rejects a non-string arg with a
    // TypeError, i.e. a 500 leaking an internal message for what is just a malformed
    // request. Coerce; `--search` wants one string either way.
    if (q) {
      args.push('--search', String(q));
    }
    const r = await run('gh', args, { cwd: repoPath, env: ENV });
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'gh issue list failed');
    const items = JSON.parse(r.stdout || '[]') as GithubIssue[];
    return items.map((it) => ({
      id: String(it.number),
      title: it.title,
      subtitle: `#${it.number}${it.labels?.length ? ` · ${it.labels.map((l) => l.name).join(', ')}` : ''}`,
      url: it.url,
    }));
  },
  async seed(_cfg, { repoPath, id }) {
    const r = await run('gh', ['issue', 'view', String(id), '--json', 'number,title,body,url'], {
      cwd: repoPath,
      env: ENV,
    });
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'gh issue view failed');
    const it = JSON.parse(r.stdout) as GithubIssue;
    return { source: 'github', id: String(it.number), title: it.title, body: it.body || '', url: it.url };
  },
};

export default adapter;
