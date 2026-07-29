// Component tests render for real, so they need the DOM matchers and a clean document
// between cases — a leaked component keeps its subscriptions and the next test asserts
// against the previous one's markup.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/svelte';
import { afterEach } from 'vitest';

afterEach(cleanup);
