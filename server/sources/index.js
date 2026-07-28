// Source adapters. Each returns the same seed shape:
//   { source, id, title, body, url }
// list(cfg, {repoPath, q}) → [{ id, title, subtitle }]  (for the picker)
// seed(cfg, {repoPath, id, text }) → seed
import freetext from './freetext.ts';
import github from './github.ts';
import gitlab from './gitlab.ts';
import asana from './asana.ts';

const ADAPTERS = { freetext, github, gitlab, asana };

// `source` comes straight off the URL, and a plain object literal inherits from
// Object.prototype — so ADAPTERS['constructor'] is a function, `a` is truthy, and
// `a.isEnabled(cfg)` is a TypeError: GET /api/sources/constructor/items answered 500
// with an internal message instead of the "not available" this module already knows
// how to say. Own-key lookup only.
function adapterFor(source) {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, source) ? ADAPTERS[source] : null;
}

function enabled(cfg) {
  return Object.values(ADAPTERS)
    .filter((a) => a.isEnabled(cfg))
    .map((a) => ({ id: a.id, label: a.label, needsRepo: !!a.needsRepo }));
}

async function list(cfg, source, params) {
  const a = adapterFor(source);
  if (!a || !a.isEnabled(cfg)) return { ok: false, error: `source '${source}' not available`, items: [] };
  try { return { ok: true, items: await a.list(cfg, params || {}) }; }
  catch (e) { return { ok: false, error: e.message, items: [] }; }
}

async function seed(cfg, source, params) {
  const a = adapterFor(source);
  if (!a || !a.isEnabled(cfg)) throw new Error(`source '${source}' not available`);
  return a.seed(cfg, params || {});
}

export { ADAPTERS, adapterFor, enabled, list, seed };
