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
  completed?: boolean;
  /**
   * Which section of which project the task sits in.
   *
   * Asana has no "status" field — the SECTION is the workflow column, so "Backlog" and
   * "In Progress" are section names. A task can be in several projects; the first
   * membership with a section is the one shown, because a task tracked in two boards is
   * rare and picking the first is better than rendering both in a chip.
   */
  memberships?: Array<{ section?: { name?: string } | null }>;
}

function cfgOf(cfg: PartialDeep<Config>): AsanaConfig {
  return cfg.sources?.asana || {};
}

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

/**
 * The workspaces a token can see.
 *
 * Connecting Asana otherwise means finding a "Workspace GID" — a number with no UI
 * anywhere in Asana that surfaces it, which you get by reading it out of a URL. The token
 * already knows the answer, so asking the user for it is asking them to do an API call by
 * hand. Exported for the settings route rather than being part of SourceAdapter: no other
 * tracker has this shape of ambiguity, so it is not a contract, it is one adapter's helper.
 */
export async function workspaces(cfg: PartialDeep<Config>): Promise<Array<{ gid: string; name: string }>> {
  return api<Array<{ gid: string; name: string }>>(cfg, '/workspaces?opt_fields=name');
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
    // `workspace` is set here because isEnabled() demands it, and sources/index.ts runs
    // that gate before it reaches either of these two calls.
    const tasks = await api<AsanaTask[]>(
      cfg,
      `/tasks?assignee=me&workspace=${encodeURIComponent(a.workspace!)}&completed_since=now&opt_fields=name,permalink_url&limit=30`,
    );
    return tasks.map((t) => ({ id: t.gid, title: t.name, subtitle: 'Asana task', url: t.permalink_url }));
  },
  /**
   * Where the task sits in its board.
   *
   * The gid comes out of the permalink — `/0/<project>/<task>` and the newer
   * `/1/<ws>/project/<p>/task/<t>` both end in it, possibly followed by `/f`. Parsed
   * rather than stored, so a link pasted by hand works exactly like one from intake.
   */
  async status(cfg, url) {
    const gid = /(\d+)(?:\/f)?\/?$/.exec(String(url || ''))?.[1];
    if (!gid) return null;
    const t = await api<AsanaTask>(cfg, `/tasks/${gid}?opt_fields=completed,memberships.section.name`);
    // `completed` outranks the section: a task can sit in "In Progress" and be ticked,
    // and the tick is the more definite statement.
    if (t.completed) return { label: 'Done', done: true };
    const section = (t.memberships || []).map((m) => m.section?.name).find(Boolean);
    return section ? { label: section, done: false } : null;
  },
  async seed(cfg, { id }) {
    const t = await api<AsanaTask>(cfg, `/tasks/${id}?opt_fields=name,notes,permalink_url`);
    return { source: 'asana', id: t.gid, title: t.name, body: t.notes || '', url: t.permalink_url };
  },
};

export default adapter;
