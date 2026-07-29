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
 * Two projects, because the two layers want different environments and mixing them
 * costs every store test a jsdom it does not use:
 *   stores — node, no DOM, the pure logic and the SSE stitching
 *   components — jsdom, @testing-library/svelte, what actually renders
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
    projects: [
      {
        extends: true,
        test: { name: 'stores', environment: 'node', include: ['src/lib/stores/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'components',
          environment: 'jsdom',
          include: ['src/lib/components/**/*.test.ts'],
          setupFiles: ['./vitest.setup.ts'],
        },
      },
    ],
  },
});
