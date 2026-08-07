/*
 * Assembling a feature's links.
 *
 * The rules that matter are about ABSENCE and about not-recognising — the happy path is
 * a string concatenation. What can go wrong is a chip that silently disappears, or a URL
 * from a tracker nobody wrote code for being treated as an error.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { assemble, labelFor, providerFor, SHIPPED_PROVIDERS } from '../server/links.ts';

const mr = (repo: string, number: number, over: Record<string, unknown> = {}) => ({
  repo,
  hasPR: true,
  provider: 'gitlab',
  number,
  url: `https://gitlab1.develop.accept.blue/ab/${repo}/-/merge_requests/${number}`,
  state: 'opened',
  ...over,
});

test('ticket, then one chip per repo, then pins — the order you read them in', () => {
  const out = assemble({
    ticketUrl: 'https://app.asana.com/0/1/task/1183',
    ci: [mr('accept-blue', 1907), mr('merchant-v3', 573)],
    repos: ['accept-blue', 'merchant-v3'],
    pins: [{ label: 'Design doc', url: 'https://notion.so/x' }],
  });
  assert.deepEqual(
    out.map((l) => l.kind),
    ['ticket', 'pr', 'pr', 'pin'],
  );
  assert.equal(out[1].label, 'accept-blue !1907', "gitlab's own notation, which people read fluently");
});

test('a repo with NO merge request still gets a chip — the gap is the signal', () => {
  /*
   * An absent chip cannot say "this half still needs opening": it looks exactly like a
   * repo you forgot was in the feature. Flat and unclickable, so it reads as a gap rather
   * than as something that failed to load.
   */
  const out = assemble({
    ci: [mr('accept-blue', 1907)],
    repos: ['accept-blue', 'merchant-v3', 'ab-su'],
  });
  const gaps = out.filter((l) => l.empty);
  assert.deepEqual(
    gaps.map((l) => l.label),
    ['merchant-v3', 'ab-su'],
  );
  assert.equal(gaps[0].url, '', 'nothing to open');
  assert.equal(gaps[0].repo, 'merchant-v3', 'the rail needs to know whose row it belongs on');
});

test('github keeps # and gitlab keeps !', () => {
  const out = assemble({ ci: [mr('web', 42, { provider: 'github' })], repos: ['web'] });
  assert.equal(out[0].label, 'web #42');
});

test('only a state worth the width is shown', () => {
  // `opened` is the resting state and says nothing; draft and merged change the meaning.
  const open = assemble({ ci: [mr('a', 1)], repos: ['a'] })[0];
  assert.equal(open.sub, '');
  const merged = assemble({ ci: [mr('a', 1, { state: 'merged' })], repos: ['a'] })[0];
  assert.equal(merged.sub, 'merged');
});

test('the feature ticket OUTRANKS the session it came from', () => {
  // Links are keyed by feature precisely so they survive the session; a ticket set by
  // hand must not be overwritten by whatever intake happened to guess.
  const out = assemble({
    ticketUrl: 'https://app.asana.com/0/1/task/999',
    session: { source: 'asana', sourceUrl: 'https://app.asana.com/0/1/task/111' },
  });
  assert.match(out[0].url, /999$/);
});

test('…but falls back to the session when the feature has no ticket of its own', () => {
  const out = assemble({ session: { source: 'asana', sourceUrl: 'https://app.asana.com/0/1/task/111' } });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'ticket');
});

test('an UNRECOGNISED url still works — pasting a link is never an error', () => {
  /*
   * The property the whole provider design exists to protect. A Confluence page, a
   * Grafana dashboard and a Google Doc all pin fine with no code and no config.
   */
  const out = assemble({ pins: [{ url: 'https://wiki.internal.example.com/a/b' }] });
  assert.equal(out[0].label, 'wiki.internal.example.com', 'the hostname carries it');
  assert.equal(out[0].glyph, '', 'no mark rather than a wrong one');
});

test('a label the user typed wins over the derived one', () => {
  const out = assemble({ pins: [{ label: 'Staging', url: 'https://app.asana.com/0/1/task/5' }] });
  assert.equal(out[0].label, 'Staging');
  assert.equal(out[0].glyph, '◎', 'still recognised, so it keeps its mark');
});

test('a pin with no url is dropped, not rendered as a link to nowhere', () => {
  assert.deepEqual(assemble({ pins: [{ label: 'oops', url: '   ' }] }), []);
});

test('a SELF-HOSTED gitlab is recognised, which a hostname test could never do', () => {
  // `gitlab1.develop.accept.blue` matches nothing by equality; substring is the point.
  const p = providerFor('https://gitlab1.develop.accept.blue/ab/x/-/issues/12', SHIPPED_PROVIDERS);
  assert.equal(p?.id, 'gitlab');
  assert.equal(labelFor('https://gitlab1.develop.accept.blue/ab/x/-/issues/12', p), 'GitLab 12');
});

test('an id pattern extracts the short name; a BAD one degrades to the plain label', () => {
  // The real permalink shape, `/0/<project>/<task>`: the LAST number is the task. A
  // keyword-anchored pattern picked the project id here — plausible on a chip, and wrong.
  assert.equal(labelFor('https://app.asana.com/0/1200999/1201777', SHIPPED_PROVIDERS[0]), 'Asana 1201777');
  assert.equal(labelFor('https://app.asana.com/0/1200999/1201777/f', SHIPPED_PROVIDERS[0]), 'Asana 1201777');
  // A hand-written regex in config is not worth a 500.
  const broken = { id: 'x', match: 'example.com', label: 'X', idPattern: '([' };
  assert.equal(labelFor('https://example.com/a', broken), 'X');
});

test('a user provider is tried BEFORE the shipped ones, so it can override', () => {
  const jira = {
    id: 'jira',
    match: 'atlassian.net',
    label: 'Jira',
    glyph: '◇',
    idPattern: '/browse/([A-Z]+-\\d+)',
  };
  const out = assemble({
    pins: [{ url: 'https://acme.atlassian.net/browse/AB-1183' }],
    providers: [jira, ...SHIPPED_PROVIDERS],
  });
  // Adding a tracker is a config line, not a code change — this is that claim, tested.
  assert.equal(out[0].label, 'Jira AB-1183');
  assert.equal(out[0].glyph, '◇');
});

test('nothing configured anywhere yields nothing, rather than an empty chip', () => {
  assert.deepEqual(assemble({}), []);
});
