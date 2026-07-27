<script>
  import TopBar from '$lib/components/TopBar.svelte';
</script>

<svelte:head><title>Worktree Studio</title></svelte:head>

<TopBar />

<div class="main">
  <section class="dock">
    <div class="empty">
      <div class="empty-glyph">⎇</div>
      <h2>No session selected</h2>
      <p>
        Start one from any source — free text, a GitHub / GitLab issue, or an Asana task. It boots a
        real Claude&nbsp;Code session on your CLAUDE.md, and you promote it to a worktree when it&rsquo;s
        real work.
      </p>
    </div>
  </section>
</div>

<style>
  /* The rail column is reserved even though the rail itself is not ported yet, so the
     dock measures the same width it will in the finished app — the terminal sizes itself
     from that box and a later width change would mean a pty resize on every session. */
  .main { flex:1; display:grid; grid-template-columns: var(--rail-w) 1fr; min-height:0; }
  .dock { display:flex; flex-direction:column; min-height:0; min-width:0; grid-column:2; }
  .empty { margin:auto; text-align:center; max-width:440px; padding:40px; color:var(--muted); }
  .empty-glyph { font-size:40px; color:var(--border-strong); }
  .empty h2 { margin:12px 0 6px; color:var(--ink); font-size:20px; }
  .empty p { font-size:14px; line-height:1.55; }
</style>
