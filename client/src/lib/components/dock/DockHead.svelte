<script lang="ts">
  import type { Session } from '../../../../../server/types';
  /*
   * The dock header: identity on the left of the one bar — dot, title, worktree name,
   * links, repo chips — with the ActionBar's verbs right-aligned in the same row.
   *
   * It used to carry ＋repo, Promote, Open in editor, Rename, Resume/Deactivate and
   * Delete as well. Every one of those also lives in the ActionBar, ~600px below, and
   * two of them were worded differently in the two places (`Resume` vs `↻ Resume`) —
   * so the same verb appeared twice on one screen and looked like two verbs.
   *
   * That top-informs / bottom-acts split is gone, and deliberately: it cost a whole
   * horizontal band at the foot of the window — one that also carried a `workspace`
   * readout repeating the repo chips already up here — and it put the ports and the
   * buttons that start them in different places. One bar, and the terminal gets the
   * height back. (The tab strip stays separate: its controls switch views rather than
   * acting on the selection.)
   */
  import { labelForSource } from '$lib/stores/ui.svelte.js';
  import { appUrl, webAppsFor, world } from '$lib/stores/world.svelte.js';
  import LinkChip from '$lib/components/LinkChip.svelte';
  import ActionBar from '$lib/components/ActionBar.svelte';

  let { session }: { session: Session } = $props();

  /*
   * Collision and drift for this feature — see server/overlap.ts.
   *
   * Read through the feature, not the session: the answer is about worktrees, and a
   * feature is what owns those. `$state` for the expansion because the list of files is
   * worth showing on demand and worth staying out of the way otherwise.
   */
  let showOverlap = $state(false);

  /** Sources that mean "typed here", which is the default and says nothing. */
  const LOCAL_SOURCES = new Set(['text', 'freetext', '']);

  /*
   * The worktree name, when it is not already what the title says.
   *
   * The rail shows `session.title || feature.name` and the dock showed `session.title`
   * alone — so after a rename the two surfaces named the same thing differently, and the
   * worktree identity (what groups the repos, what `wt` and tmux use, what the paths are)
   * appeared in the dock nowhere at all. Mirrors FeatureCard's second line exactly, and
   * is absent for the untouched majority whose title IS the worktree name.
   */
  const feature = $derived(world.featureFor(session.id));
  const links = $derived(world.linksFor(feature));
  const wtname = $derived(feature?.name || '');
  const lap = $derived(world.overlapFor(feature?.name));
  const conflictCount = $derived(lap?.drift.reduce((n, d) => n + d.conflicts.length, 0) || 0);

  /*
   * A running repo's ports, folded into its own chip.
   *
   * They used to be a second row of chips — `workspace · accept-blue · merchant-v3` — at
   * the foot of the window, naming the same repos this row already names. One list of
   * repos, and a port is a fact ABOUT a repo, so it belongs on that repo's chip.
   */
  const serverRepos = $derived(world.servers[session.id]?.repos || []);
  const portsFor = (repo: string): number[] =>
    serverRepos.find((r) => r.repo === repo && r.running)?.ports || [];

  /**
   * The port to open in a browser, for a repo that has one.
   *
   * `webAppsFor` is the same judgement the ActionBar used for its "Open <repo> ↗" buttons
   * — config.webRepos ∩ running-with-a-port — so a chip becomes a link under exactly the
   * condition that used to produce a button.
   */
  const webPorts = $derived(
    new Map(webAppsFor(serverRepos.map((r) => ({ ...r, running: r.running }))).map((w) => [w.repo, w.port])),
  );
  const webPort = (repo: string, ports: number[]): number | null =>
    ports.length ? (webPorts.get(repo) ?? null) : null;
  const showWtname = $derived(!!wtname && wtname !== session.title.trim());

  /** Before promote there is one implicit chip for the primary repo. */
  const repoChips = $derived(
    session.repos && session.repos.length
      ? session.repos
      : [{ repo: session.repoName, primary: true, worktreePath: session.worktreePath }],
  );


</script>

<div class="dock-head">
  <!-- A title and a label: this dot has no accompanying text, so without them the agent's
       state is conveyed by hue and nothing else. -->
  <span class="dot {session.state}" role="img" aria-label="Agent is {session.state}" title="The agent is {session.state}"></span>
  <span class="dock-title">{session.title}</span>
  {#if showWtname}<span class="wtname" title="The worktree name — what groups these repos">{wtname}</span>{/if}
  {#if session.sourceUrl}
    <a class="link" href={session.sourceUrl} target="_blank" rel="noreferrer">{labelForSource(session)}</a>
  {:else}
    <!-- Only a source worth naming. A locally-created session's source is the free-text
         adapter's id, so this printed FREETEXT on the header of most features forever —
         the check named 'text' and the adapter is called 'freetext', so it never fired.
         FeatureCard suppresses defaults the same way. -->
    {#if session.source && !LOCAL_SOURCES.has(session.source)}<span class="src">{session.source}</span>{/if}
  {/if}

  <!-- The ticket and every repo's merge request, in the header, because this is where
       identity lives. The MR chips used to sit in the dev-server readout below, so they
       vanished for any repo with no `start` entry — a link hidden behind a condition that
       has nothing to do with it. -->
  {#if links.length}
    <span class="links">
      {#each links as l (l.kind + l.label)}<LinkChip link={l} />{/each}
    </span>
  {/if}

  <!--
    WHAT ELSE IS TOUCHING THESE FILES. server/overlap.ts computes it; this is the only
    place in the app that can tell you, because it is the only place that knows about
    every worktree at once. Named, not counted: "18 shared" is a number you dismiss,
    "18 files also changed by iso-mfa-totp" is a name you recognise.
  -->
  <!--
    DEDUPED BY FEATURE for the label, not for the detail. Collisions are recorded per
    REPO, so a BE+FE feature that overlaps in both repos is two entries — correct data,
    and "custom-reports, custom-reports" in a chip that is meant to name who you are
    colliding with. The expanded list below keeps them apart, because there the repo is
    the thing you need in order to go and look.
  -->
  {#if lap && lap.collisions.length}
    {@const total = lap.collisions.reduce((n, c) => n + c.files.length, 0)}
    <button
      class="overlapchip"
      title={lap.collisions
        .map((c) => `${c.feature} (${c.repo}): ${c.files.slice(0, 12).join(', ')}${c.files.length > 12 ? `, +${c.files.length - 12} more` : ''}`)
        .join('\n')}
      onclick={() => (showOverlap = !showOverlap)}
      aria-expanded={showOverlap}
    >⚠ {total} file{total === 1 ? '' : 's'} also changed by {[...new Set(lap.collisions.map((c) => c.feature))].join(', ')}</button>
  {/if}
  {#if lap && lap.behind >= 5}
    <span class="driftchip" title={lap.drift.map((d) => `${d.repo}: behind ${d.behind}, ahead ${d.ahead}${d.conflicts.length ? ` — ${d.conflicts.length} file(s) will conflict: ${d.conflicts.slice(0, 8).join(', ')}` : ''}`).join('\n')}
      >behind {lap.behind}{#if conflictCount}<span class="willconflict"> · {conflictCount} will conflict</span>{/if}</span>
  {/if}

  <span class="repochips">
    {#each repoChips as r (r.repo)}
      {@const ports = portsFor(r.repo)}
      {@const web = webPort(r.repo, ports)}
      <!--
        A running WEB repo's chip IS the way into the app.
        It already names the repo and gives the port, which is the whole content of an
        "Open <repo> ↗" button — so the button does not move here, it stops existing. That
        matters because those buttons were per-repo and appeared only while a server was
        up, i.e. they grew the bar in exactly the state where it was busiest.

        Only web repos become links. A backend chip staying inert is information the bar
        did not carry before: it says which of these you can actually look at.
      -->
      {#if web}
        <a
          class="repochip2 up link"
          class:primary={r.primary}
          href={appUrl(web)}
          target="_blank"
          rel="noreferrer"
          title="Open {r.repo} at :{web}"
        >{r.primary ? '★ ' : ''}{r.repo}{r.worktreePath ? ' ⎇' : ''}<span class="ports">:{web} ↗</span></a>
      {:else}
        <span
          class="repochip2"
          class:primary={r.primary}
          class:up={ports.length > 0}
          title={r.worktreePath || 'main (not promoted)'}
        >{r.primary ? '★ ' : ''}{r.repo}{r.worktreePath ? ' ⎇' : ''}{#if ports.length}<span class="ports"
          >{ports.map((p) => `:${p}`).join(' ')}</span>{/if}</span>
      {/if}
    {/each}
  </span>

  <span class="grow"></span>
  <ActionBar />

  {#if showOverlap && lap}
    <!-- Full width under the bar: a file list is a list, and squeezing it into a tooltip
         is how you learn there are 18 of them without learning which. -->
    <div class="overlapdetail">
      {#each lap.collisions as c (c.feature + c.repo)}
        <div class="ovrow">
          <b>{c.feature}</b> <span class="ovrepo">{c.repo}</span>
          <div class="ovfiles">{#each c.files as f (f)}<code>{f}</code>{/each}</div>
        </div>
      {/each}
      {#each lap.drift.filter((d) => d.conflicts.length) as d (d.repo)}
        <div class="ovrow">
          <b>will conflict on rebase</b> <span class="ovrepo">{d.repo}</span>
          <div class="ovfiles">{#each d.conflicts as f (f)}<code>{f}</code>{/each}</div>
        </div>
      {/each}
    </div>
  {/if}

</div>

<style>
  /* Warning-coloured because it is about somebody else's work landing on yours; a button
     because the useful part is WHICH files, and that has to be reachable. */
  .overlapchip { font-family:var(--mono); font-size:11px; color:var(--del); background:none;
                 border:1px solid var(--del); border-radius:6px; padding:2px 7px; cursor:pointer;
                 white-space:nowrap; max-width:340px; overflow:hidden; text-overflow:ellipsis; }
  .overlapchip:hover { background:var(--del); color:var(--panel); }
  .driftchip { font-family:var(--mono); font-size:11px; color:var(--faint);
               border:1px solid var(--border); border-radius:6px; padding:2px 7px; white-space:nowrap; }
  .driftchip .willconflict { color:var(--waiting); }
  .overlapdetail { flex-basis:100%; margin-top:6px; padding:9px 11px; background:var(--bg);
                   border:1px solid var(--border); border-radius:9px; display:flex;
                   flex-direction:column; gap:8px; max-height:34vh; overflow-y:auto; }
  .ovrow b { font-size:12.5px; }
  .ovrow .ovrepo { font-family:var(--mono); font-size:10.5px; color:var(--faint); }
  .ovfiles { display:flex; flex-wrap:wrap; gap:4px; margin-top:4px; }
  .ovfiles code { font-family:var(--mono); font-size:11px; color:var(--muted);
                  background:var(--elevated); border-radius:4px; padding:1px 5px; }
  /* The feature's colour tag, inherited from .dock (see Dock.svelte). This is the surface
     that matters: the rail is what you SCAN, but the dock is what you are looking at while
     you work, so a tag only in the rail would be invisible at the moment you switch.
     `var(--fc, …)` falls back to the untagged look, so nothing changes without a tag. */
  .dock-head { display:flex; align-items:center; gap:10px; padding:12px 16px; border-bottom:1px solid var(--border);
               background:var(--fc-wash, var(--panel)); box-shadow:inset 4px 0 0 var(--fc, transparent);
               flex:none; flex-wrap:wrap; }
  .wtname { font-family:var(--mono); font-size:11.5px; color:var(--faint); overflow:hidden;
            text-overflow:ellipsis; white-space:nowrap; max-width:220px; }
  .dock-title { font-weight:650; font-size:16px; max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .links { display:flex; align-items:center; gap:6px; flex-wrap:wrap; min-width:0; }
  .repochips { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .repochip2 { font-family:var(--mono); font-size:11.5px; color:var(--muted); border:1px solid var(--border); border-radius:6px; padding:2px 7px; }
  .repochip2.primary { color:var(--brand); border-color:var(--brand); }
  /* Only a running web repo. The ↗ and the hover are what make a chip read as pressable —
     a clickable chip is quieter than a button, and this is what pays that back. */
  a.repochip2.link { text-decoration:none; cursor:pointer; }
  a.repochip2.link:hover, a.repochip2.link:focus-visible { border-color:var(--brand); color:var(--ink); }
  a.repochip2.link:hover .ports, a.repochip2.link:focus-visible .ports { color:var(--brand); }
  /* Running: the chip earns the same green the port numbers always wore. */
  .repochip2.up { border-color:var(--done); }
  .ports { color:var(--done); margin-left:6px; }
  .grow { flex:1; }
</style>
