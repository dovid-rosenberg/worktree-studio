'use strict';
// Source adapters. Each returns the same seed shape:
//   { source, id, title, body, url }
// list(cfg, {repoPath, q}) → [{ id, title, subtitle }]  (for the picker)
// seed(cfg, {repoPath, id, text }) → seed
const freetext = require('./freetext');
const github = require('./github');
const gitlab = require('./gitlab');
const asana = require('./asana');

const ADAPTERS = { freetext, github, gitlab, asana };

function enabled(cfg) {
  return Object.values(ADAPTERS)
    .filter((a) => a.isEnabled(cfg))
    .map((a) => ({ id: a.id, label: a.label, needsRepo: !!a.needsRepo }));
}

async function list(cfg, source, params) {
  const a = ADAPTERS[source];
  if (!a || !a.isEnabled(cfg)) return { ok: false, error: `source '${source}' not available`, items: [] };
  try { return { ok: true, items: await a.list(cfg, params || {}) }; }
  catch (e) { return { ok: false, error: e.message, items: [] }; }
}

async function seed(cfg, source, params) {
  const a = ADAPTERS[source];
  if (!a || !a.isEnabled(cfg)) throw new Error(`source '${source}' not available`);
  return a.seed(cfg, params || {});
}

module.exports = { ADAPTERS, enabled, list, seed };
