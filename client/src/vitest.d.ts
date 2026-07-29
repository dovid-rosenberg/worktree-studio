/*
 * Makes jest-dom's matchers (toBeInTheDocument, toHaveAttribute…) visible to
 * svelte-check, not just to Vitest at runtime.
 *
 * vitest.setup.ts imports the same module so the matchers EXIST when tests run; this
 * file is what puts their types in the compilation, since svelte-check builds its own
 * program and never sees the setup file.
 */
import '@testing-library/jest-dom/vitest';
