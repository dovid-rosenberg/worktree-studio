import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

/*
 * The client had no test runner at all until now — `svelte-check` is type checking, not
 * testing, and every UI bug in this project's history was found by driving a browser by
 * hand. None of that was repeatable.
 *
 * The svelte plugin is what makes `.svelte.ts` modules work here: the stores use
 * runes ($state/$derived) at module and class-field level, which are compiler
 * constructs, so the plugin has to process them before Vitest sees them. Without it,
 * importing world.svelte.ts throws on the first `$state`.
 *
 * `environment: 'node'` on purpose — these are the store and pure-logic tests, which
 * need no DOM. Component rendering (jsdom + testing-library) is the next layer and can
 * add its own environment when it lands.
 */
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    // `$lib` comes from SvelteKit's own plugin, which is not in this pipeline — without
    // it every store import fails on the first `$lib/...` specifier.
    alias: { $lib: path.resolve(import.meta.dirname, 'src/lib') },
    // Vitest resolves the browser condition to the runtime that expects a component
    // context; these run outside one.
    conditions: ['browser'],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
