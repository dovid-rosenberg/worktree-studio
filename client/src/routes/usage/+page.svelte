<script lang="ts">
  // Harness for the telemetry surface. Mirrors /search: the shell mounts UsagePanel (or
  // SessionUsage alone, scoped to one session) wherever it belongs; this exists to prove
  // both shapes against a live daemon.
  import UsagePanel from '$lib/components/insights/UsagePanel.svelte';
  import SessionUsage from '$lib/components/insights/SessionUsage.svelte';
  import { listSessions } from '$lib/components/insights/api.js';
  import { theme, toggleTheme } from '$lib/theme.svelte.js';

    let sessions: import('$lib/components/insights/types.js').StateSession[] = $state([]);
  let solo = $state('');

  $effect(() => {
    listSessions().then((s) => { sessions = s; }).catch(() => {});
  });
</script>

<div class="harness">
  <header class="topbar">
    <div class="brand"><span class="glyph">◧</span> Token &amp; cost telemetry</div>
    <span class="muxbadge">harness</span>
    <span class="spacer"></span>
    <label class="pick">
      <span>solo session view</span>
      <select class="mini-select" bind:value={solo}>
        <option value="">off (fleet panel)</option>
        {#each sessions as s (s.id)}<option value={s.id}>{s.title}</option>{/each}
      </select>
    </label>
    <button class="btn ghost sm" onclick={toggleTheme}>{theme.current === 'dark' ? 'Light' : 'Dark'}</button>
    <a class="btn ghost sm" href="/search">← Search</a>
  </header>

  <main class="scroll">
    {#if solo}
      <div class="solo">
        <p class="note">
          <code>&lt;SessionUsage sessionId="{solo}" /&gt;</code> — fetching its own payload,
          the way a session-scoped mount in the shell would.
        </p>
        {#key solo}
          <SessionUsage sessionId={solo} />
        {/key}
      </div>
    {:else}
      <UsagePanel />
    {/if}
  </main>
</div>

<style>
  .harness { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .topbar {
    display: flex; align-items: center; gap: 12px; row-gap: 8px; flex-wrap: wrap;
    padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--panel); flex: none;
  }
  .brand { font-weight: 700; font-size: 15px; letter-spacing: -.01em; display: flex; align-items: center; gap: 7px; }
  .brand .glyph { color: var(--brand); font-size: 17px; }
  .muxbadge { font-family: var(--mono); font-size: 11px; color: var(--muted); border: 1px solid var(--border); border-radius: 6px; padding: 2px 8px; }
  .pick { display: inline-flex; align-items: center; gap: 6px; }
  .pick > span { font-family: var(--mono); font-size: 9.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); }

  .scroll { flex: 1; min-height: 0; overflow-y: auto; background: var(--bg); }
  .solo { padding: 18px; display: flex; flex-direction: column; gap: 16px; max-width: 900px; }
  .note { margin: 0; font-size: 12px; color: var(--faint); }
  .note code { font-family: var(--mono); font-size: 11.5px; }
</style>
