<script>
  /*
   * Harness for the Changes panel — NOT the shell.
   *
   * The rail, dock chrome and the SSE state layer are another agent's work, and this
   * route deliberately owns none of them: it pulls /api/v1/state once, lets you pick a
   * session, and mounts <ReviewPanel> at full height. That is enough to develop and
   * prove the panel against a live daemon in isolation, and it means the panel's only
   * contract with the shell is the one prop it takes.
   *
   *   /review              → first session with a worktree
   *   /review?session=<id> → that session, deep-linkable while iterating
   */
  import { onMount } from 'svelte';
  import ReviewPanel from '$lib/components/review/ReviewPanel.svelte';
  import { api } from '$lib/api.js';
  import { toggleTheme, theme } from '$lib/theme.svelte.js';

  let sessions = $state(/** @type {{ id:string, title:string, worktreePath?:string, repos?:{repo:string}[] }[]} */ ([]));
  let selected = $state('');
  let error = $state(/** @type {string|null} */ (null));
  /** @type {'unified'|'split'} */
  let view = $state('unified');

  onMount(async () => {
    try {
      // Through the shared helper, not a bare fetch: /api/v1/state is behind the boot
      // token like every other route, and a bare fetch here 401'd against a real daemon.
      const st = await api('GET', '/api/v1/state');
      // Only promoted sessions have a worktree, and only those have anything to review.
      sessions = (st.sessions || []).filter((/** @type {any} */ s) => s.worktreePath);
      const want = new URLSearchParams(location.search).get('session');
      selected = (want && sessions.some((s) => s.id === want) ? want : sessions[0] && sessions[0].id) || '';
    } catch (e) {
      error = /** @type {Error} */ (e).message;
    }
  });

  /** Keep the URL shareable as the picker moves, without a navigation. */
  function pick(/** @type {Event} */ e) {
    selected = /** @type {HTMLSelectElement} */ (e.currentTarget).value;
    const u = new URL(location.href);
    u.searchParams.set('session', selected);
    history.replaceState(null, '', u);
  }
</script>

<svelte:head><title>Changes — review harness</title></svelte:head>

<div class="harness">
  <header class="bar">
    <span class="brand">Worktree Studio</span>
    <span class="tag">review harness</span>
    {#if error}
      <span class="err">/api/v1/state failed: {error}</span>
    {:else}
      <select class="mini-select wide" value={selected} onchange={pick} aria-label="Session">
        {#each sessions as s (s.id)}
          <option value={s.id}>{s.title} · {(s.repos || []).map((r) => r.repo).join(', ')}</option>
        {/each}
      </select>
    {/if}
    <span class="spacer"></span>
    <button class="btn sm ghost" onclick={toggleTheme}>{theme.current === 'light' ? '☾' : '☀'} theme</button>
  </header>

  {#if selected}
    {#key selected}
      <ReviewPanel sessionId={selected} {view} />
    {/key}
  {:else if !error}
    <div class="empty">No session with a worktree. Promote one, or start the daemon this harness proxies to.</div>
  {/if}
</div>

<style>
  .harness { position:fixed; inset:0; display:flex; flex-direction:column; min-height:0; }
  .bar { flex:none; display:flex; align-items:center; gap:10px; padding:8px 14px; border-bottom:1px solid var(--border); background:var(--panel); }
  .brand { font-weight:700; font-size:13px; }
  .tag { font-family:var(--mono); font-size:9.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--brand); border:1px solid var(--brand); border-radius:5px; padding:1px 6px; }
  .spacer { flex:1; }
  .wide { max-width:340px; }
  .err { color:var(--del); font-family:var(--mono); font-size:11px; }
  .empty { padding:24px; color:var(--faint); font-family:var(--mono); font-size:12px; }
</style>
