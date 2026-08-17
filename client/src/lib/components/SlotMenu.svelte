<script lang="ts">
  /*
   * Pick a concurrency slot — the caret next to ▶ Start, and the slot badge on a running
   * feature. One component for both, because the only real differences are the trigger
   * glyph and the heading; the list, the occupancy rules and the dismissal behaviour are
   * the same question asked twice.
   *
   * Occupancy is fetched per open rather than read off the topology frame. It depends on
   * what is listening right now, and computing it for every feature on every frame would
   * put an lsof per slot per feature on the broadcast path.
   *
   * Dismissal matches OverflowMenu deliberately: outside click, and Escape captured so
   * the global handler does not read a bare Escape as "interrupt the agent" and send it
   * to the pty.
   */
  import type { SlotReport } from '../../../../server/types';
  import { api } from '$lib/api.js';
  import { errMessage } from '$lib/errmsg.js';

  let {
    feature,
    mode,
    current = null,
    onpick,
  }: {
    feature: string;
    mode: 'start' | 'move';
    /** The feature's slot, for the badge label in `move` mode. */
    current?: number | null;
    onpick: (slot: number, report: SlotReport) => void;
  } = $props();

  let open = $state(false);
  let root = $state<HTMLElement | null>(null);
  let slots = $state<SlotReport[]>([]);
  let error = $state('');
  let loading = $state(false);

  const repos = $derived(
    [...new Set(slots.flatMap((s) => Object.keys(s.ports)))].join(' + '),
  );

  async function load() {
    loading = true;
    error = '';
    try {
      slots = await api('GET', `/api/v1/group/${encodeURIComponent(feature)}/slots`);
    } catch (e) {
      error = errMessage(e);
      slots = [];
    } finally {
      loading = false;
    }
  }

  function toggle(e: MouseEvent) {
    // The badge lives inside a clickable rail card; opening the menu must not also
    // select the card behind it.
    e.stopPropagation();
    open = !open;
    if (open) load();
  }

  /** Close before acting — a confirm dialog must not open behind a menu still on screen. */
  function pick(s: SlotReport) {
    open = false;
    onpick(s.slot, s);
  }

  const pickable = (s: SlotReport) => s.state === 'free';

  /** The second line: why you cannot have it, or what you would get. */
  function detail(s: SlotReport): string {
    if (s.state === 'held') return `held by ${s.heldBy}`;
    if (s.state === 'blocked') return `port ${s.blockedBy?.port} held by pid ${s.blockedBy?.pid}`;
    const parts = Object.entries(s.ports)
      .filter(([, ps]) => ps.length)
      .map(([repo, ps]) => `${repo} ${ps.join('·')}`);
    return parts.length ? parts.join(' · ') : 'no slot-governed ports';
  }

  const pillText = (s: SlotReport) =>
    s.state === 'current' ? 'current' : s.state === 'held' ? 'in use' : s.state;

  $effect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (root && e.target instanceof Node && !root.contains(e.target)) open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        open = false;
      }
    };
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onKey, true);
    };
  });
</script>

<div class="slotmenu" class:badgemode={mode === 'move'} bind:this={root}>
  {#if mode === 'start'}
    <button
      class="btn caret"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label="Choose a slot"
      title="Start on a specific slot"
      onclick={toggle}
    >▾</button>
  {:else}
    <button
      class="badge slot"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label="Change slot"
      title="Concurrency slot — its ports are offset by slot·100. Click to move this feature."
      onclick={toggle}
    >slot {current} ▾</button>
  {/if}

  {#if open}
    <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
    <div class="sheet" role="menu" tabindex="-1">
      <div class="mhead">
        {mode === 'start' ? 'Start on slot' : 'Move to slot'}{repos ? ` · ${repos}` : ''}
      </div>

      {#if loading}
        <p class="msg">Reading slots…</p>
      {:else if error}
        <p class="msg bad">{error}</p>
      {:else}
        {#each slots as s (s.slot)}
          <button
            class="slotrow"
            role="menuitem"
            type="button"
            disabled={!pickable(s)}
            onclick={(e) => { e.stopPropagation(); pick(s); }}
          >
            <span class="tag">{s.slot}</span>
            <span class="lines">
              <span class="l1">Slot {s.slot}</span>
              <span class="l2" class:warn={s.state === 'held'} class:bad={s.state === 'blocked'}
                >{detail(s)}</span
              >
            </span>
            <span class="state {s.state}">{pillText(s)}</span>
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .slotmenu { position: relative; display: inline-flex; }

  .caret { border-radius: 0 8px 8px 0; padding: 7px 9px; font-size: 11px; margin-left: -1px; }

  .badge.slot {
    font-family: var(--mono); font-size: 11px; font-weight: 600;
    padding: 2px 7px; border-radius: 999px; cursor: pointer;
    color: var(--working); background: var(--working-bg);
    border: 1px solid transparent;
  }
  .badge.slot:hover { border-color: var(--working); }

  .sheet {
    position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 60;
    min-width: 330px; padding: 6px;
    background: var(--panel); border: 1px solid var(--border-strong);
    border-radius: 10px; box-shadow: var(--shadow);
    text-align: left;
    /* Five slots is a tall list. */
    max-height: min(62vh, 420px); overflow-y: auto;
  }
  /* The badge sits high in a pane, so its sheet drops rather than rises. */
  .badgemode .sheet { bottom: auto; top: calc(100% + 8px); }

  .mhead {
    font-family: var(--mono); font-size: 10.5px; letter-spacing: .09em;
    text-transform: uppercase; color: var(--faint); padding: 7px 10px 6px;
  }
  .msg { margin: 0; padding: 8px 10px; color: var(--muted); font-size: 13px; }
  .msg.bad { color: var(--del); }

  .slotrow {
    display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 10px;
    width: 100%; text-align: left; padding: 9px 10px; border-radius: 7px;
    border: 1px solid transparent; background: transparent; color: var(--ink);
    cursor: pointer; font-family: inherit; font-size: 13.5px;
  }
  .slotrow:hover:not(:disabled) { background: var(--elevated); border-color: var(--border); }
  .slotrow:disabled { cursor: not-allowed; opacity: .62; }

  .tag {
    font-family: var(--mono); font-weight: 700; font-size: 12px;
    min-width: 19px; height: 19px; display: grid; place-items: center;
    border-radius: 5px; color: var(--working); background: var(--working-bg);
  }
  .lines { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .l1 { font-weight: 600; }
  .l2 {
    font-family: var(--mono); font-size: 11.5px; color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .l2.warn { color: var(--waiting); }
  .l2.bad { color: var(--del); }

  .state {
    font-family: var(--mono); font-size: 10.5px; letter-spacing: .06em;
    text-transform: uppercase; padding: 2px 7px; border-radius: 999px; white-space: nowrap;
  }
  .state.free { color: var(--done); background: var(--done-bg); }
  .state.held { color: var(--waiting); background: var(--waiting-bg); }
  .state.blocked { color: var(--del); background: var(--del-bg); }
  .state.current { color: var(--working); background: var(--working-bg); }
</style>
