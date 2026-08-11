/*
 * CAN THIS GO OUT?
 *
 * The answer lives in four places: the merge request (open? approved? mergeable?), its
 * pipeline (green?), git (pushed? behind?), and the fact that a feature is several repos
 * and needs ALL of them. Answering it meant checking each by hand, per repo, and the
 * commonest way to get it wrong was to check three and forget the fourth.
 *
 * A PURE FUNCTION over data the client already has. Both halves — `ci` and `overlap` —
 * ride the same frame, so this adds no request, no subprocess and no state; it is the
 * sentence those two numbers already implied.
 *
 * IT NEVER SAYS "READY" ON A GUESS. Every blocker here is something a forge or git
 * asserted. Where the forge declined to answer (`mergeable: null` — an older GitLab, a
 * provider that does not report it) the verdict is `unknown`, not `ready`: telling
 * somebody their work is shippable is exactly the claim not to make on missing data.
 */
import type { CiRepo, FeatureOverlap } from '../../../server/types';

export type ShipState = 'ready' | 'blocked' | 'waiting' | 'unknown';

export interface ShipBlocker {
  repo: string;
  /** One short sentence, already in English — this is what the UI prints. */
  text: string;
  /** `blocked` stops a release; `waiting` resolves itself if you leave it alone. */
  kind: 'blocked' | 'waiting';
}

export interface ShipVerdict {
  state: ShipState;
  blockers: ShipBlocker[];
  /** How many of the feature's repos have an open merge request. */
  withPr: number;
  repos: number;
}

/** The forge's slug → the sentence a person would say. */
const REASON: Record<string, string> = {
  conflicts: 'has merge conflicts',
  'needs-rebase': 'needs a rebase before it can merge',
  'not-approved': 'is not approved yet',
  draft: 'is still a draft',
  checks: 'is waiting on its checks',
  other: 'is not mergeable yet',
};

/**
 * @param ci      one row per repo of the feature — the `ci` frame's entry for its session
 * @param overlap the feature's drift, or null when the sweep has not reached it
 */
export function shipVerdict(ci: CiRepo[], overlap: FeatureOverlap | null): ShipVerdict {
  const blockers: ShipBlocker[] = [];
  const repos = ci.length;
  let withPr = 0;
  let unknown = false;

  for (const r of ci) {
    if (!r.hasPR) {
      blockers.push({ repo: r.repo, text: 'has no merge request', kind: 'blocked' });
      continue;
    }
    withPr += 1;

    const c = r.checks;
    if (c?.failed) {
      blockers.push({ repo: r.repo, text: `has ${c.failed} failing check(s)`, kind: 'blocked' });
    } else if (c?.running) {
      // Resolves itself. Worth naming so "not ready" does not look like a problem, but
      // not worth the same colour as something you have to act on.
      blockers.push({ repo: r.repo, text: `has ${c.running} check(s) still running`, kind: 'waiting' });
    }

    if (r.blockedBy) {
      blockers.push({
        repo: r.repo,
        text: `${REASON[r.blockedBy] || 'is not mergeable yet'}`,
        kind: r.blockedBy === 'checks' ? 'waiting' : 'blocked',
      });
    } else if (r.mergeable == null) {
      // The forge did not say. Not a blocker — there is nothing to do about it — but it
      // does mean we cannot claim the feature is ready.
      unknown = true;
    }
  }

  /*
   * The blocker no forge can see.
   *
   * A merge request can be open, green and approved while the commit that answers the
   * review comment is still on this laptop: the forge is describing what it was pushed,
   * which is not what you have.
   */
  for (const d of overlap?.drift || []) {
    if (d.unpushed) {
      blockers.push({ repo: d.repo, text: `has ${d.unpushed} unpushed commit(s)`, kind: 'blocked' });
    }
  }

  if (!repos) return { state: 'unknown', blockers: [], withPr: 0, repos: 0 };

  const state: ShipState = blockers.some((b) => b.kind === 'blocked')
    ? 'blocked'
    : blockers.length
      ? 'waiting'
      : unknown
        ? 'unknown'
        : 'ready';

  return { state, blockers, withPr, repos };
}

/** The one-line summary the bar shows before you expand it. */
export function shipLabel(v: ShipVerdict): string {
  if (v.state === 'ready') return v.repos > 1 ? `ready · ${v.repos} repos` : 'ready to merge';
  if (v.state === 'waiting') return 'waiting on checks';
  if (v.state === 'unknown') return '';
  // The count, not the reasons: the reasons are a click away and there can be six of them.
  const n = v.blockers.filter((b) => b.kind === 'blocked').length;
  return n === 1 ? '1 thing to fix' : `${n} things to fix`;
}
