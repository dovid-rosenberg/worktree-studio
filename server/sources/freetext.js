'use strict';
// The zero-dependency origin: type a description.
module.exports = {
  id: 'freetext',
  label: 'Free text',
  needsRepo: false,
  isEnabled() { return true; },
  async list() { return []; },
  async seed(cfg, { text }) {
    const body = (text || '').trim();
    const title = body.split('\n')[0].slice(0, 80) || 'New session';
    return { source: 'freetext', id: null, title, body, url: null };
  },
};
