/*
 * A feature's links: the ticket it came from, its merge requests, and anything pinned.
 *
 * Studio already knew all three facts and showed almost none of them. The ticket was a
 * link reading just "Asana" — no task, no id — on session rows only. Each repo's MR was a
 * pill inside the DEV-SERVER readout, so it vanished for any repo with no `start` entry,
 * and a feature with no session had neither. Right data, wrong places.
 *
 * Two design decisions are load-bearing here:
 *
 * KEYED BY FEATURE. A link outlives the session that produced it — you delete and restart
 * agents on the same piece of work, and the ticket does not change. The colour tag moved
 * to the feature for the same reason, and the ticket now follows it rather than dying
 * with `session.sourceUrl`.
 *
 * PROVIDERS ARE PATTERNS, NOT ADAPTERS. Recognising a URL needs no auth, no API shape and
 * no error handling — the URL is already in hand and the only questions are what to call
 * it and how to shorten it. Making display an adapter would mean holding a Jira token
 * just to render the word "Jira". So a provider is a substring to match, a label, a glyph
 * and an optional capture pattern, and adding one is a config line.
 *
 * The property worth insisting on: an UNRECOGNISED url still works. It renders under its
 * hostname with no glyph, so pasting any link is never an error and recognition only ever
 * makes it prettier.
 */
import type { CiRepo, LinkProvider, Session } from './types.ts';

/** One resolved link, ready to render. */
export interface Link {
  /** `ticket` and `pr` are derived; `pin` is what the user added by hand. */
  kind: 'ticket' | 'pr' | 'pin';
  url: string;
  /** What the chip says — "AB-1183", "accept-blue !1907", "Design doc". */
  label: string;
  /** The provider's mark, or '' when nothing recognised it. */
  glyph: string;
  /** Secondary text: a task title, a PR state, ''. */
  sub?: string;
  /** For a PR chip with no MR yet — rendered flat and unclickable. */
  empty?: boolean;
  /** Pipeline counts, PR chips only. */
  checks?: { passed: number; running: number; failed: number; total: number };
  /** Which repo a `pr` link belongs to, so the rail can put it on the right row. */
  repo?: string;
}

/** A pinned link as it is stored: nothing derived, nothing resolved. */
export interface PinnedLink {
  label?: string;
  url: string;
}

/**
 * Shipped recognisers. Deliberately short.
 *
 * Jira and Linear are absent on purpose — they would be config, not code, and shipping
 * recognisers for trackers nobody here uses would assert flexibility rather than leave
 * room for it. `config.linkProviders` is concatenated ahead of these, so a user entry
 * both adds new trackers and overrides a shipped one.
 */
export const SHIPPED_PROVIDERS: LinkProvider[] = [
  /*
   * Asana's task id is the LAST numeric segment, not one after a keyword. A permalink is
   * `/0/<project>/<task>`, newer links are `/1/<ws>/project/<p>/task/<t>`, and both may
   * carry a trailing `/f`. Anchoring on a keyword picked the PROJECT id out of the first
   * form — which looks perfectly plausible on a chip and is simply the wrong number.
   */
  { id: 'asana', match: 'asana.com', label: 'Asana', glyph: '◎', idPattern: '(\\d+)(?:/f)?/?$' },
  { id: 'github', match: 'github.com', label: 'GitHub', glyph: '⑂', idPattern: '/(?:issues|pull)/(\\d+)' },
  {
    id: 'gitlab',
    match: 'gitlab',
    label: 'GitLab',
    glyph: '⑂',
    idPattern: '/(?:issues|merge_requests)/(\\d+)',
  },
];

/** The hostname, or '' for anything that is not a parseable absolute URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * The first provider whose `match` appears in the URL.
 *
 * Matched against the WHOLE url rather than the hostname: a self-hosted GitLab is
 * `gitlab1.develop.accept.blue`, which no hostname equality test would ever catch, and
 * `gitlab` as a substring is what makes one rule cover both gitlab.com and every private
 * instance. The cost is that a path containing the word could match — acceptable, since
 * the only consequence is a chip wearing the wrong label.
 */
export function providerFor(url: string, providers: LinkProvider[]): LinkProvider | null {
  const u = String(url || '');
  if (!u) return null;
  return providers.find((p) => p.match && u.includes(p.match)) || null;
}

/**
 * What to call a link when the user gave it no label.
 *
 * `idPattern`'s first capture group wins — that is how "AB-1183" comes out of an Asana
 * URL rather than the whole path. A bad pattern in config must not take the route down
 * with it, so an invalid regex degrades to the provider's plain label.
 */
export function labelFor(url: string, p: LinkProvider | null): string {
  if (!p) return hostOf(url) || url;
  if (p.idPattern) {
    try {
      const m = new RegExp(p.idPattern).exec(url);
      if (m?.[1]) return `${p.label} ${m[1]}`;
    } catch {
      /* a hand-written pattern is not worth a 500 */
    }
  }
  return p.label || hostOf(url) || url;
}

/** Resolve one pinned link, honouring a label the user typed over the derived one. */
function pin(entry: PinnedLink, providers: LinkProvider[]): Link | null {
  const url = String(entry?.url || '').trim();
  if (!url) return null;
  const p = providerFor(url, providers);
  return {
    kind: 'pin',
    url,
    label: String(entry.label || '').trim() || labelFor(url, p),
    glyph: p?.glyph || '',
  };
}

/** `#` for GitHub, `!` for GitLab — each forge's own notation, which people read fluently. */
function prTag(r: CiRepo): string {
  return `${r.provider === 'gitlab' ? '!' : '#'}${r.number}`;
}

/**
 * Every link a feature has, in the order they are shown.
 *
 * Ticket first (what you are doing), then one chip per repo (where the work is), then
 * pins (whatever else you kept). Pure: no forge, no network, no config lookup — which is
 * what lets the ordering and the empty-chip rule be tested without any of that.
 */
export function assemble(input: {
  session?: Pick<Session, 'source' | 'sourceUrl'> | null;
  /** The feature's own ticket, which outlives the session; falls back to the session's. */
  ticketUrl?: string | null;
  ci?: CiRepo[];
  /** Repos in the feature, so one with no MR can still be shown. */
  repos?: string[];
  pins?: PinnedLink[];
  providers?: LinkProvider[];
}): Link[] {
  const providers = input.providers?.length ? input.providers : SHIPPED_PROVIDERS;
  const out: Link[] = [];

  const ticket = String(input.ticketUrl || input.session?.sourceUrl || '').trim();
  if (ticket) {
    const p = providerFor(ticket, providers);
    out.push({ kind: 'ticket', url: ticket, label: labelFor(ticket, p), glyph: p?.glyph || '' });
  }

  const ci = input.ci || [];
  const byRepo = new Map(ci.filter((r) => r.hasPR).map((r) => [r.repo, r]));
  /*
   * Every repo gets a chip, including one with no merge request.
   *
   * The absence IS the signal — it is what tells you which half of a feature still needs
   * opening — and an absent chip cannot say that, because it looks identical to a repo
   * you forgot was in the feature. Rendered flat and unclickable, so it reads as a gap
   * rather than as something that failed to load.
   */
  for (const repo of input.repos?.length ? input.repos : ci.map((r) => r.repo)) {
    const hit = byRepo.get(repo);
    if (!hit) {
      out.push({ kind: 'pr', url: '', label: repo, glyph: '⑂', sub: 'no MR', empty: true, repo });
      continue;
    }
    out.push({
      kind: 'pr',
      url: hit.url || '',
      label: `${repo} ${prTag(hit)}`,
      glyph: '⑂',
      // `opened` is the resting state and says nothing; draft and merged both change
      // what the chip MEANS, so only those are worth the width.
      sub: hit.state && hit.state !== 'opened' ? hit.state : '',
      checks: hit.checks,
      repo,
    });
  }

  for (const entry of input.pins || []) {
    const link = pin(entry, providers);
    if (link) out.push(link);
  }
  return out;
}
