/*
 * The Vite config Studio launches a slotted frontend with. It lives HERE, in Studio's
 * install directory, and never inside the repo.
 *
 * Why this file exists
 * --------------------
 * A frontend hardcodes its backend's port in a gitignored source file (`src/config.js`),
 * so pointing it at slot n's backend used to mean REWRITING that file on disk —
 * `applyConfigPatch`. That write was never reverted, so the last slot a worktree ran at
 * survived the feature that made it, and a plain `npm run dev` from an editor inherited
 * Studio's private state: the config said `localhost:1339`, nothing runs on 1339 unless
 * Studio started it, and every API call failed with ERR_CONNECTION_REFUSED. Studio had
 * broken a workflow that does not involve Studio.
 *
 * So the rewrite moved off the disk and into the module graph. The file on disk keeps
 * the base port forever — a vanilla launch is correct by construction — and the slot's
 * port is substituted in memory, per request, by the `transform` hook below.
 *
 * Why the base config is imported through a variable
 * --------------------------------------------------
 * Vite bundles a config file with esbuild before executing it, and its `externalize-deps`
 * plugin returns early on `path.isAbsolute(id)` — meaning a STATIC absolute import of the
 * repo's config would be inlined into that bundle rather than left as a real import.
 * Computing the specifier at runtime keeps it a genuine dynamic import that esbuild
 * cannot statically resolve, so the repo's config is loaded as its own module, from its
 * own directory, resolving its own bare dependencies out of its own node_modules.
 *
 * `.mjs`, not `.ts`, deliberately: Vite decides ESM-vs-CJS for a config from its
 * extension, and this file must be ESM in every case because it uses top-level await.
 */
import path from 'node:path';
import { rewriteAllSiblingPorts } from './slot-rewrite.ts';

const RAW = process.env.WTS_SLOT_VITE;
if (!RAW) {
  throw new Error(
    'slot-vite-config: WTS_SLOT_VITE is not set. This config is launched by Worktree ' +
      'Studio, which supplies it; to run the app by hand use the repo\'s own vite config.',
  );
}

/**
 * @type {{
 *   root: string, baseConfig: string, file: string,
 *   siblingPortEnv: Record<string, number>,
 *   offsetStep: number, maxSlots: number, slot: number, port?: number,
 * }}
 */
const S = JSON.parse(RAW);

// The one module whose source gets the substitution. Compared as an absolute path so a
// same-named file elsewhere in the graph (another package's `src/config.js`) is not hit.
const TARGET = path.resolve(S.root, S.file);

/*
 * Rewrite the frontend's backend port in memory.
 *
 * `enforce: 'pre'` so this sees the raw source, before any other plugin has had a chance
 * to rewrite it into something the port pattern no longer matches.
 *
 * Returning null for every other module is the whole safety story: exactly one file in
 * the graph is eligible, and even that one is left byte-for-byte when the rewrite is a
 * no-op (slot 0, or a config naming no port of this backend's families).
 */
const slotPortPlugin = {
  name: 'wts:slot-port',
  enforce: 'pre',
  transform(code, id) {
    // Vite appends query suffixes (`?v=…`, `?import`) to ids; the file is before the `?`.
    if (id.split('?')[0] !== TARGET) return null;
    const out = rewriteAllSiblingPorts(
      code,
      S.siblingPortEnv,
      S.offsetStep,
      S.maxSlots,
      S.slot,
    );
    // No map: the substitution is equal-length-agnostic but line- and column-preserving
    // (it only ever swaps digits inside one token), so the original mapping still holds.
    return out === code ? null : { code: out, map: null };
  },
};

const mod = await import(S.baseConfig);

export default async (configEnv) => {
  // A repo config may export either an object or a (possibly async) function of the Vite
  // env — `defineConfig` accepts both, so both have to be unwrapped here. The env is
  // passed straight through so a function-form config sees the real command and mode.
  const base = typeof mod.default === 'function' ? await mod.default(configEnv) : mod.default;

  return {
    ...base,
    // The config is outside the project, so Vite cannot infer the project directory.
    root: S.root,
    plugins: [...(base?.plugins ?? []), slotPortPlugin],
    server: {
      ...base?.server,
      // Studio owns the port: the repo's own config hardcodes one, and two worktrees
      // running it would otherwise fight over that single number.
      ...(S.port ? { port: S.port } : {}),
    },
  };
};
