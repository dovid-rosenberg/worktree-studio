<script>
  /*
   * One session in the rail.
   *
   * The whole point of the port lives here: this card is rendered once per session and
   * then *updated in place* as frames arrive. app.js rebuilt the entire rail with
   * `rail.innerHTML = ''` on every SSE tick — i.e. several times a second while a
   * session is working — which destroyed focus, scroll position and any open menu.
   */
  import { activatable } from '$lib/actions/activatable.js';
  import { ui, labelForSource } from '$lib/stores/ui.svelte.js';
  import { world } from '$lib/stores/world.svelte.js';

  let { session } = $props();

  const promoted = $derived(!!session.worktreePath);
  const srv = $derived((world.servers[session.id] && world.servers[session.id].repos) || []);
  const running = $derived(srv.filter((/** @type {any} */ r) => r.running));
  const ports = $derived(running.flatMap((/** @type {any} */ r) => r.ports || []));
  const selected = $derived(ui.selectedId === session.id);
  /** The repo chips: every repo of a promoted feature, or just "main" before promote. */
  const repoTags = $derived(
    promoted
      ? (session.repos && session.repos.length
        ? session.repos.map((/** @type {any} */ r) => r.repo)
        : [session.repoName])
      : ['main'],
  );
</script>

<div
  class="scard"
  class:sel={selected}
  class:running={running.length > 0}
  data-id={session.id}
  aria-pressed={selected}
  use:activatable={() => ui.select(session.id)}
>
  <div class="scard-top">
    <span class="dot {session.state}"></span>
    <span class="scard-title">{session.title}</span>
    {#if running.length}
      <span class="pill run" title="Dev servers running{ports.length ? ` — :${ports.join(' :')}` : ''}">
        <span class="pi">⇅</span>running
      </span>
    {:else}
      <span class="pill {session.state}">{session.state}</span>
    {/if}
  </div>
  <div class="scard-meta">
    <span class="src">{session.source}</span>
    {#if session.sourceUrl}
      <!-- A real link, so a click must not also select the card. -->
      <a
        class="link"
        href={session.sourceUrl}
        target="_blank"
        rel="noreferrer"
        onclick={(e) => e.stopPropagation()}
      >{labelForSource(session)}</a>
    {/if}
    {#each repoTags as r (r)}<span class="grp">{r}</span>{/each}
  </div>
  <div class="scard-act">{session.activity || ''}</div>
</div>

<style>
  .scard { border:1px solid var(--border); border-radius:10px; padding:10px 11px; cursor:pointer; background:var(--panel); transition:border-color .12s, background .12s; }
  @media (prefers-reduced-motion:reduce){ .scard { transition:none; } }
  .scard:hover { border-color:var(--border-strong); }
  .scard.sel { border-color:var(--brand); background:var(--elevated); }
  .scard.running { box-shadow:inset 3px 0 0 var(--done); }
  .scard-top { display:flex; align-items:center; gap:8px; }
  .scard-title { font-weight:600; font-size:13px; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .scard-meta { display:flex; align-items:center; gap:7px; margin-top:6px; font-family:var(--mono); font-size:10.5px; color:var(--muted); flex-wrap:wrap; }
  .scard-act { margin-top:6px; font-family:var(--mono); font-size:10.5px; color:var(--faint); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
</style>
