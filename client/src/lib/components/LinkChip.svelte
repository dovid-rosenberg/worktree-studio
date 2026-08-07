<script lang="ts">
  /*
   * One link — a ticket, a merge request, or something pinned.
   *
   * ONE component for all three, and for all three placements. The dock header, the
   * ActionBar overflow and anywhere else render this, so a chip cannot come to mean
   * different things in different corners — which is exactly how the same PR ended up
   * shown as a `cistat` pill in the ServerBar and as nothing at all on the rail.
   *
   * An `empty` chip (a repo in the feature with no MR yet) is a <span>, not an <a>: there
   * is nothing to open, and a link that goes nowhere is worse than a label. The gap is
   * still drawn, because absence is the signal — it is what tells you which half of a
   * feature still needs a merge request opened.
   */
  import type { Link } from '../../../../server/links';

  let { link }: { link: Link } = $props();

  /** Only counts worth the width: zeroes say nothing a missing chip does not. */
  const checks = $derived(
    [
      { cls: 'ok', n: link.checks?.passed || 0, mark: '✓' },
      { cls: 'run', n: link.checks?.running || 0, mark: '◴' },
      { cls: 'x', n: link.checks?.failed || 0, mark: '✕' },
    ].filter((c) => c.n > 0),
  );

  const title = $derived(
    link.empty
      ? `${link.repo} has no open merge request`
      : `${link.label}${link.sub ? ` — ${link.sub}` : ''}\n${link.url}`,
  );
</script>

{#if link.empty}
  <span class="chip empty" {title}>
    <span class="g">{link.glyph}</span>{link.label}<span class="sub">{link.sub}</span>
  </span>
{:else}
  <a
    class="chip"
    class:merged={link.sub === 'merged'}
    class:draft={link.sub === 'draft'}
    href={link.url}
    target="_blank"
    rel="noreferrer"
    {title}
  >
    {#if link.glyph}<span class="g">{link.glyph}</span>{/if}{link.label}
    {#if link.sub}<span class="sub">{link.sub}</span>{/if}
    {#each checks as c (c.cls)}<span class="ck {c.cls}">{c.mark}{c.n}</span>{/each}
  </a>
{/if}

<style>
  .chip { display:inline-flex; align-items:center; gap:6px; font-family:var(--mono); font-size:11.5px;
          color:var(--ink); border:1px solid var(--border); border-radius:6px; padding:2px 9px;
          text-decoration:none; white-space:nowrap; max-width:260px; overflow:hidden; text-overflow:ellipsis; }
  a.chip:hover, a.chip:focus-visible { border-color:var(--brand); }
  .g { color:var(--brand); flex:none; }
  .sub { color:var(--faint); }

  /* A gap, not a failure: dashed and muted so it reads as "nothing here yet" rather than
     as something that did not load. No hover, because there is nothing to press. */
  .empty { border-style:dashed; color:var(--muted); }
  .empty .g { color:var(--faint); }

  /* Merged agrees with the ✓ on the rail card — same fact, same colour. */
  .merged, .merged .g, .merged .sub { color:var(--done); }
  .merged { border-color:var(--done); }
  /* A draft exists but is not asking for review, so it recedes. */
  .draft { border-style:dashed; color:var(--muted); }
  .draft .g { color:var(--muted); }

  .ck { flex:none; font-size:11px; }
  .ck.ok { color:var(--done); }
  .ck.run { color:var(--waiting); }
  .ck.x { color:var(--del); }
</style>
