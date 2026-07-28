// Asana tasks via the REST API (personal access token in config).
import type { Config, PartialDeep, SourceAdapter } from '../types.ts';

/** The `sources.asana` block as this adapter reads it: defensively, key by key. */
type AsanaConfig = PartialDeep<NonNullable<Config['sources']['asana']>>;

/** The task fields the two calls below ask for by `opt_fields`. */
interface AsanaTask {
  gid: string;
  name: string;
  notes?: string;
  permalink_url: string;
}

function cfgOf(cfg: PartialDeep<Config>): AsanaConfig { return (cfg.sources && cfg.sources.asana) || {}; }

// Unwraps the Asana envelope and hands back its `data`. Generic rather than `any`
// because the shape varies by endpoint and only the caller knows which one it asked
// for — this way the caller's `AsanaTask[]`/`AsanaTask` is the checked type of the
// expression rather than an annotation on an `any` that means nothing.
async function api<T>(cfg: PartialDeep<Config>, pathAndQuery: string): Promise<T> {
  const a = cfgOf(cfg);
  const res = await fetch(`https://app.asana.com/api/1.0${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${a.token}` },
  });
  if (!res.ok) throw new Error(`Asana API ${res.status}`);
  return ((await res.json()) as { data: T }).data;
}

const adapter: SourceAdapter = {
  id: 'asana',
  label: 'Asana',
  needsRepo: false,
  isEnabled(cfg) {
    const a = cfgOf(cfg);
    return !!a.enabled && !!a.token && !!a.workspace;
  },
  async list(cfg) {
    const a = cfgOf(cfg);
    // `workspace` is set here because isEnabled() demands it, and sources/index.js runs
    // that gate before it reaches either of these two calls.
    const tasks = await api<AsanaTask[]>(cfg, `/tasks?assignee=me&workspace=${encodeURIComponent(a.workspace!)}&completed_since=now&opt_fields=name,permalink_url&limit=30`);
    return tasks.map((t) => ({ id: t.gid, title: t.name, subtitle: 'Asana task' }));
  },
  async seed(cfg, { id }) {
    const t = await api<AsanaTask>(cfg, `/tasks/${id}?opt_fields=name,notes,permalink_url`);
    return { source: 'asana', id: t.gid, title: t.name, body: t.notes || '', url: t.permalink_url };
  },
};

export default adapter;
