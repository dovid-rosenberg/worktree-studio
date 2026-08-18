import { describe, expect, it } from 'vitest';
import { shipLabel, shipVerdict } from './ship';
import type { CiRepo, FeatureOverlap } from '../../../server/types';

/*
 * "Can this go out?" — the sentence four separate readouts already implied.
 *
 * The rule these tests exist to defend is the one that is tempting to break: it must
 * never say READY on missing data. Everything else is arithmetic; that one is a promise.
 */

const pr = (over: Partial<CiRepo> = {}): CiRepo => ({
  repo: 'accept-blue',
  hasPR: true,
  number: 1909,
  url: 'https://git/mr/1909',
  state: 'opened',
  checks: { passed: 1, running: 0, failed: 0, total: 1 },
  mergeable: true,
  blockedBy: '',
  ...over,
});

const drift = (over: Partial<FeatureOverlap['drift'][number]> = {}): FeatureOverlap => ({
  behind: 0,
  ahead: 1,
  drift: [{ repo: 'accept-blue', behind: 0, ahead: 1, conflicts: [], unpushed: 0, ...over }],
});

describe('shipVerdict', () => {
  it('says ready only when every repo has a green, mergeable, pushed MR', () => {
    const v = shipVerdict([pr(), pr({ repo: 'merchant-v3', number: 575 })], drift());
    expect(v.state).toBe('ready');
    expect(v.blockers).toEqual([]);
    expect(v.withPr).toBe(2);
  });

  it('names the repo that has no merge request', () => {
    /*
     * The commonest way to get this wrong by hand: check the backend, ship, and discover
     * the frontend half was never opened. A feature is all of its repos.
     */
    const v = shipVerdict([pr(), pr({ repo: 'merchant-v3', hasPR: false })], drift());
    expect(v.state).toBe('blocked');
    expect(v.blockers).toContainEqual({ repo: 'merchant-v3', text: 'has no merge request', kind: 'blocked' });
  });

  it('separates what you must fix from what will fix itself', () => {
    // Running checks are not a problem, they are a wait. Colouring them the same as a
    // failure trains you to ignore the colour.
    const running = shipVerdict([pr({ checks: { passed: 0, running: 2, failed: 0, total: 2 } })], drift());
    expect(running.state).toBe('waiting');
    expect(running.blockers[0].kind).toBe('waiting');

    const failed = shipVerdict([pr({ checks: { passed: 0, running: 0, failed: 1, total: 1 } })], drift());
    expect(failed.state).toBe('blocked');
    expect(failed.blockers[0].kind).toBe('blocked');
  });

  it('turns the forge’s vocabulary into a sentence', () => {
    for (const [slug, words] of [
      ['conflicts', 'has merge conflicts'],
      ['needs-rebase', 'needs a rebase before it can merge'],
      ['not-approved', 'is not approved yet'],
      ['draft', 'is still a draft'],
    ] as const) {
      const v = shipVerdict([pr({ mergeable: false, blockedBy: slug })], drift());
      expect(v.blockers[0].text).toBe(words);
      expect(v.state).toBe('blocked');
    }
  });

  it('counts unpushed commits, which no forge can see', () => {
    /*
     * An MR can be open, green and approved while the commit answering the review comment
     * is still on this laptop. The forge is describing what it was pushed.
     */
    const v = shipVerdict([pr()], drift({ unpushed: 3 }));
    expect(v.state).toBe('blocked');
    expect(v.blockers).toContainEqual({
      repo: 'accept-blue',
      text: 'has 3 unpushed commit(s)',
      kind: 'blocked',
      // The one blocker here Studio can clear itself — POST /group/push.
      action: 'push',
    });
  });

  it('treats "never pushed" as not-a-count, not as zero', () => {
    // `null` means there is no remote branch at all. It is not "0 unpushed", and reporting
    // it as a blocker of size null would print "has null unpushed commit(s)".
    const v = shipVerdict([pr()], drift({ unpushed: null }));
    expect(v.blockers.filter((b) => b.text.includes('unpushed'))).toEqual([]);
  });

  it('says UNKNOWN, never ready, when the forge declined to answer', () => {
    /*
     * THE PROMISE. An older GitLab, or a provider that does not report mergeability, sends
     * `mergeable: null`. Everything visible looks fine — so the tempting shortcut is to
     * call it ready. Telling somebody their work is shippable is the one claim not to make
     * on data you do not have.
     */
    const v = shipVerdict([pr({ mergeable: null, blockedBy: '' })], drift());
    expect(v.state).toBe('unknown');
    expect(shipLabel(v)).toBe('');
  });

  it('has no verdict at all for a feature with no repos yet', () => {
    expect(shipVerdict([], null).state).toBe('unknown');
  });

  it('summarises blockers by count, not by listing them', () => {
    const v = shipVerdict(
      [pr({ hasPR: false }), pr({ repo: 'merchant-v3', mergeable: false, blockedBy: 'conflicts' })],
      drift({ unpushed: 2 }),
    );
    expect(shipLabel(v)).toBe('3 things to fix');
    // One is a real sentence, so the panel can still say what they are.
    expect(v.blockers).toHaveLength(3);
  });

  it('names the repo count when a ready feature spans several', () => {
    expect(shipLabel(shipVerdict([pr()], drift()))).toBe('ready to merge');
    expect(shipLabel(shipVerdict([pr(), pr({ repo: 'merchant-v3' })], drift()))).toBe('ready · 2 repos');
  });
});
