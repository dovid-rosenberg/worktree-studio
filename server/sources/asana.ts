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
 * Who a token belongs to, and which workspaces it can see — in ONE call.
 *
 * Both halves of "is this connected?" come from `/users/me`. The name is what makes the
 * answer meaningful to a human: a green tick proves a request succeeded, "David
 * Rosenberg" proves it succeeded AS YOU, which is the thing actually being asserted when
 * a picker says "assigned to me".
 *
 * The workspace matters because Asana surfaces its GID nowhere in its own UI — you get it
 * by reading a URL. Asking a user for it is asking them to make an API call by hand.
 */
export async function verify(
  token: string,
): Promise<{ name: string; workspaces: Array<{ gid: string; name: string; tasks: number }> }> {
  const cfg = { sources: { asana: { enabled: true, token, workspace: '' } } };
  const me = await api<{ name?: string; workspaces?: Array<{ gid: string; name: string }> }>(
    cfg,
    '/users/me?opt_fields=name,workspaces.name',
  );
  const list = (me.workspaces || []).slice(0, MAX_WORKSPACES);

  /*
   * How many tasks each workspace has ASSIGNED TO YOU.
   *
   * Names are not unique. This account has two workspaces both called "accept.blue" — one
   * holding twenty tasks and one holding none — so a picker showing the name alone offers
   * the same word twice with no way to choose. Picking the empty one yields a connection
   * that works perfectly and lists nothing, which is indistinguishable from a broken
   * integration, and is exactly what happened here.
   *
   * A count answers the question actually being asked — "which one has my work?" — rather
   * than asking someone to decode a gid. One extra request per workspace, bounded, and
   * only while connecting.
   */
  const counted = await Promise.all(
    list.map(async (w) => {
      try {
        const tasks = await api<Array<unknown>>(
          cfg,
          `/tasks?assignee=me&workspace=${encodeURIComponent(w.gid)}&completed_since=now&opt_fields=gid&limit=${COUNT_CAP}`,
        );
        return { ...w, tasks: tasks.length };
      } catch {
        // A workspace that refuses the query is still selectable; -1 means "not known",
        // which the UI renders as nothing rather than as a confident zero.
        return { ...w, tasks: -1 };
      }
    }),
  );
  // Most tasks first: with several workspaces, the one you work in is almost always the
  // one your work is in.
  counted.sort((a, b) => b.tasks - a.tasks);
  return { name: me.name || 'your account', workspaces: counted };
}

/** Enough to tell workspaces apart; not a page of results. */
const COUNT_CAP = 50;
/** A guard on the fan-out above — nobody picks from a list of fifty workspaces anyway. */
const MAX_WORKSPACES = 12;

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
