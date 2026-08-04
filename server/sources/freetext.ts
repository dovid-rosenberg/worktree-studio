// The zero-dependency origin: type a description, optionally give it a short name.
import type { SourceAdapter } from '../types.ts';

const adapter: SourceAdapter = {
  id: 'freetext',
  label: 'Free text',
  needsRepo: false,
  isEnabled() {
    return true;
  },
  async list() {
    return [];
  },
  async seed(_cfg, { text, name }) {
    const body = (text || '').trim();
    // short title: explicit name, else first few words of the prompt (not the whole thing)
    const title = name?.trim() || body.split(/\s+/).slice(0, 6).join(' ').slice(0, 60) || 'New session';
    return { source: 'freetext', id: null, title, body, url: null };
  },
};

export default adapter;
