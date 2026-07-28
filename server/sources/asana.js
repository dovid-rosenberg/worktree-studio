'use strict';
// Asana tasks via the REST API (personal access token in config).
function cfgOf(cfg) { return (cfg.sources && cfg.sources.asana) || {}; }

/** @returns {Promise<any>} the Asana envelope's `data` — shape varies by endpoint */
async function api(cfg, pathAndQuery) {
  const a = cfgOf(cfg);
  const res = await fetch(`https://app.asana.com/api/1.0${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${a.token}` },
  });
  if (!res.ok) throw new Error(`Asana API ${res.status}`);
  return /** @type {any} */ (await res.json()).data;
}

module.exports = {
  id: 'asana',
  label: 'Asana',
  needsRepo: false,
  isEnabled(cfg) {
    const a = cfgOf(cfg);
    return !!a.enabled && !!a.token && !!a.workspace;
  },
  async list(cfg) {
    const a = cfgOf(cfg);
    const tasks = await api(cfg, `/tasks?assignee=me&workspace=${encodeURIComponent(a.workspace)}&completed_since=now&opt_fields=name,permalink_url&limit=30`);
    return tasks.map((t) => ({ id: t.gid, title: t.name, subtitle: 'Asana task' }));
  },
  async seed(cfg, { id }) {
    const t = await api(cfg, `/tasks/${id}?opt_fields=name,notes,permalink_url`);
    return { source: 'asana', id: t.gid, title: t.name, body: t.notes || '', url: t.permalink_url };
  },
};
