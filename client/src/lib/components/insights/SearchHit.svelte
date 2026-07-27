<script>
  // One search result. The row itself is the jump target; the session chip inside it
  // is a second, narrower action (scope the search to that session) — which is exactly
  // the nested-control case `activatable`'s `e.target === node` guard exists for, and
  // why the row is a div-with-action rather than a <button> that can't legally contain
  // another button.
  import { activatable } from '$lib/actions/activatable.js';
  import { segments } from './snippet.js';
  import { ago, stamp, shortModel } from './format.js';

  let {
    hit,
    terms = [],
    /** Hide the session line when the whole list is already scoped to one session. */
    showSession = true,
    selected = false,
    onopen = () => {},
    onscope = null,
  } = $props();

  const parts = $derived(segments(hit.snippet, terms));
  const session = $derived(hit.session || null);
  const when = $derived(Number.isFinite(hit.tsMs) ? hit.tsMs : Date.parse(hit.ts || ''));
</script>

<div
  class="hit"
  class:sel={selected}
  data-hit
  aria-label={`${hit.role} message${session ? ` in ${session.title}` : ''}, ${ago(when)} — open session`}
  use:activatable={() => onopen(hit)}
>
  <div class="l1">
    <span class="role" class:assistant={hit.role === 'assistant'}>{hit.role || '?'}</span>
    {#if showSession && session}
      {#if onscope}
        <button
          type="button"
          class="sesschip"
          title={`Only search ${session.title}`}
          onclick={(e) => { e.stopPropagation(); onscope(session.id); }}
        >
          <span class="dot {session.state || 'idle'}"></span>{session.title}
        </button>
      {:else}
        <span class="sesschip flat"><span class="dot {session.state || 'idle'}"></span>{session.title}</span>
      {/if}
      {#if session.repo}<span class="repo">{session.repo}</span>{/if}
    {/if}
    {#if hit.gitBranch}<span class="branch" title="Branch at the time of this message">{hit.gitBranch}</span>{/if}
    <span class="grow"></span>
    {#if hit.sidechain}<span class="sub" title="From a subagent, not the main thread">subagent</span>{/if}
    {#if hit.model}<span class="model">{shortModel(hit.model)}</span>{/if}
    <time class="when" datetime={hit.ts || ''} title={stamp(when)}>{ago(when)}</time>
  </div>

  <p class="snip">
    {#each parts as p, i (i)}{#if p.hit}<mark>{p.text}</mark>{:else}{p.text}{/if}{/each}
  </p>
</div>

<style>
  /* Sits on the .crow / .pcmd idiom from public/style.css: a flat row, a left accent on
     the active one, no card chrome — a results list of cards is unreadable at 40 rows. */
  .hit {
    display: block;
    padding: 9px 13px;
    border-left: 2px solid transparent;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    background: none;
  }
  .hit:hover { background: var(--elevated); }
  .hit.sel { background: var(--elevated); border-left-color: var(--brand); }

  .l1 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-family: var(--mono); font-size: 10.5px; }
  .grow { flex: 1; }

  .role {
    text-transform: uppercase; letter-spacing: .05em; font-weight: 700; font-size: 9.5px;
    color: var(--waiting); background: var(--waiting-bg); border-radius: 4px; padding: 1px 6px; flex: none;
  }
  .role.assistant { color: var(--working); background: var(--working-bg); }

  .sesschip {
    display: inline-flex; align-items: center; gap: 6px;
    font-family: var(--mono); font-size: 10.5px; color: var(--ink);
    background: transparent; border: 1px solid var(--border); border-radius: 20px;
    padding: 1px 9px 1px 7px; cursor: pointer; max-width: 200px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .sesschip:hover { border-color: var(--brand); }
  .sesschip.flat { cursor: default; }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--idle); }
  .dot.working { background: var(--working); }
  .dot.waiting { background: var(--waiting); }
  .dot.stopped { background: var(--faint); }

  .repo, .branch, .model, .sub, .when { color: var(--faint); white-space: nowrap; }
  .branch { max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
  .sub { color: var(--working); }

  .snip {
    margin: 5px 0 0;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.5;
    color: var(--muted);
    /* Transcript lines run to megabytes; the server caps the snippet, this caps the
       render so one pathological hit can't push every other result off screen. */
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }
  mark {
    background: var(--brand-soft);
    color: var(--ink);
    border-radius: 3px;
    padding: 0 2px;
    font-weight: 600;
  }
</style>
