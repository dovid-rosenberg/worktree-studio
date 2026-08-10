// GitLab issues. Prefers the `glab` CLI when installed; otherwise falls back to
// the REST API using a configured token + project path.
import type { Config, PartialDeep, SourceAdapter } from '../types.ts';
import { CHILD_ENV, run, has } from '../util.ts';

const ENV = CHILD_ENV;

/** The `sources.gitlab` block as this adapter reads it: defensively, key by key. */
type GitlabConfig = PartialDeep<NonNullable<Config['sources']['gitlab']>>;

/** The issue fields both `glab -F json` and the REST API carry, optional where the code guards. */
interface GitlabIssue {
  iid: number;
  title: string;
  description?: string;
  web_url: string;
}

function cfgOf(cfg: PartialDeep<Config>): GitlabConfig {
  return cfg.sources?.gitlab || {};
}

// The REST fallback's two required settings, checked where they are read.
//
// isEnabled() guarantees NEITHER — `has('glab')` alone satisfies it — and the CLI
// branch declines whenever there is no repoPath, which is what the picker passes
// for an unknown `?repo=`. So a glab install with an empty gitlab config reaches
// the fallback, and without this it asks for /projects/undefined with a literal
// "undefined" token and reports the resulting 401 as if the token were wrong.
function restTarget(g: GitlabConfig): { token: string; project: string } {
  if (!g.token || !g.project) {
    throw new Error(
      'GitLab: set sources.gitlab.token and sources.gitlab.project, or pick a repo with `glab` installed',
    );
  }
  return { token: g.token, project: g.project };
}

// Decoded GitLab JSON — shape varies by endpoint, so it is generic rather than
// `any`: the caller's type is then the checked type of the expression.
async function rest<T>(cfg: PartialDeep<Config>, pathAndQuery: string): Promise<T> {
  const g = cfgOf(cfg);
  const host = (g.host || 'https://gitlab.com').replace(/\/$/, '');
  const res = await fetch(`${host}/api/v4${pathAndQuery}`, {
    headers: { 'PRIVATE-TOKEN': restTarget(g).token },
  });
  if (!res.ok) throw new Error(`GitLab API ${res.status}`);
  return (await res.json()) as T;
}

const adapter: SourceAdapter = {
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
      /*
       * `--search`, which this branch simply never applied.
       *
       * `q` was destructured and then unused, so typing in the intake picker filtered
       * GitHub issues and GitLab-via-REST issues and did NOTHING for GitLab-via-glab —
       * the branch that runs whenever glab is installed, i.e. the common case. The box
       * accepted input and returned the same unfiltered 30 issues, which reads as broken
       * rather than as unimplemented.
       */
      const term = String(q ?? '').trim();
      const args = ['issue', 'list', '-P', '30', '-F', 'json'];
      if (term) args.push('--search', term);
      const r = await run('glab', args, { cwd: repoPath, env: ENV });
      if (r.code !== 0) throw new Error(r.stderr.trim() || 'glab issue list failed');
      const items = JSON.parse(r.stdout || '[]') as GitlabIssue[];
      // `#`, matching the REST branch below and GitLab's own notation. `!` is the MERGE
      // REQUEST sigil — the two branches of one lookup labelled the same issue two
      // different ways, and one of them named the wrong kind of object entirely.
      return items.map((it) => ({ id: String(it.iid), title: it.title, subtitle: `#${it.iid}` }));
    }
    const proj = encodeURIComponent(restTarget(g).project);
    const items = await rest<GitlabIssue[]>(
      cfg,
      `/projects/${proj}/issues?state=opened&per_page=30${q ? `&search=${encodeURIComponent(String(q))}` : ''}`,
    );
    return items.map((it) => ({ id: String(it.iid), title: it.title, subtitle: `#${it.iid}` }));
  },
  async seed(cfg, { repoPath, id }) {
    const g = cfgOf(cfg);
    if (has('glab') && repoPath) {
      const r = await run('glab', ['issue', 'view', String(id), '-F', 'json'], { cwd: repoPath, env: ENV });
      if (r.code !== 0) throw new Error(r.stderr.trim() || 'glab issue view failed');
      const it = JSON.parse(r.stdout) as GitlabIssue;
      return {
        source: 'gitlab',
        id: String(it.iid),
        title: it.title,
        body: it.description || '',
        url: it.web_url,
      };
    }
    const proj = encodeURIComponent(restTarget(g).project);
    const it = await rest<GitlabIssue>(cfg, `/projects/${proj}/issues/${id}`);
    return {
      source: 'gitlab',
      id: String(it.iid),
      title: it.title,
      body: it.description || '',
      url: it.web_url,
    };
  },
};

export default adapter;
