// The zero-dependency origin: type a description, optionally give it a short name.
export default {
  id: 'freetext',
  label: 'Free text',
  needsRepo: false,
  isEnabled() { return true; },
  async list() { return []; },
  async seed(cfg, { text, name }) {
    const body = (text || '').trim();
    // short title: explicit name, else first few words of the prompt (not the whole thing)
    const title = (name && name.trim())
      || body.split(/\s+/).slice(0, 6).join(' ').slice(0, 60)
      || 'New session';
    return { source: 'freetext', id: null, title, body, url: null };
  },
};
