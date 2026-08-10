// Source adapters. Each returns the same seed shape:
//   { source, id, title, body, url }
// list(cfg, {repoPath, q}) → [{ id, title, subtitle }]  (for the picker)
// seed(cfg, {repoPath, id, text }) → seed
import freetext from './freetext.ts';
import github from './github.ts';
import gitlab from './gitlab.ts';
import asana from './asana.ts';
import type {
  Config,
  PartialDeep,
  SourceAdapter,
  SourceInfo,
  SourceItem,
  SourceParams,
  SourceSeed,
} from '../types.ts';

const ADAPTERS: Record<string, SourceAdapter> = { freetext, github, gitlab, asana };

// `source` comes straight off the URL, and a plain object literal inherits from
// Object.prototype — so ADAPTERS['constructor'] is a function, `a` is truthy, and
// `a.isEnabled(cfg)` is a TypeError: GET /api/sources/constructor/items answered 500
// with an internal message instead of the "not available" this module already knows
// how to say. Own-key lookup only.
function adapterFor(source: string): SourceAdapter | null {
  return Object.hasOwn(ADAPTERS, source) ? ADAPTERS[source] : null;
}

/**
 * The enabled adapters themselves, not their descriptions.
 *
 * `enabled()` below returns SourceInfo for the picker; this returns the objects, because
 * task-status.ts needs to CALL one. Same gate, so an adapter with no token is still not
 * reachable.
 */
function enabledAdapters(cfg: PartialDeep<Config>): SourceAdapter[] {
  return Object.values(ADAPTERS).filter((a) => a.isEnabled(cfg));
}

function enabled(cfg: PartialDeep<Config>): SourceInfo[] {
  return Object.values(ADAPTERS)
    .filter((a) => a.isEnabled(cfg))
    .map((a) => ({ id: a.id, label: a.label, needsRepo: !!a.needsRepo }));
}

/** What `list()` answers with: the picker's candidates, or why there are none. */
interface ListResult {
  ok: boolean;
  error?: string;
  items: SourceItem[];
}

async function list(cfg: PartialDeep<Config>, source: string, params?: SourceParams): Promise<ListResult> {
  const a = adapterFor(source);
  if (!a?.isEnabled(cfg)) return { ok: false, error: `source '${source}' not available`, items: [] };
  try {
    return { ok: true, items: await a.list(cfg, params || {}) };
  } catch (e) {
    return { ok: false, error: (e as Error).message, items: [] };
  }
}

async function seed(cfg: PartialDeep<Config>, source: string, params?: SourceParams): Promise<SourceSeed> {
  const a = adapterFor(source);
  if (!a?.isEnabled(cfg)) throw new Error(`source '${source}' not available`);
  return a.seed(cfg, params || {});
}

export { ADAPTERS, adapterFor, enabled, enabledAdapters, list, seed };
