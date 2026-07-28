# client — Worktree Studio frontend (SvelteKit)

The port of `public/` to SvelteKit. Built with `adapter-static` in SPA mode: the output
is plain files, and **the Express daemon in `server/` remains the only server**. There is
no Node adapter, no second process, no second port in production.

`public/` is untouched and still works. Both UIs can run side by side for the whole port.

## Layout

```
client/
  svelte.config.js          adapter-static, fallback: index.html
  vite.config.js            dev/preview proxy to the daemon, and the dev boot token
  src/
    app.html                pre-paint theme script + the __WTS_TOKEN__ placeholder
    app.css                 design tokens + global primitives, ported from public/style.css
    lib/
      api.js                the boot token, api(method,url,body), busy()
      ops.svelte.js         every mutating action (promote, popout, stacks, features…)
      shortcuts.svelte.js   global keys (⌘K, ⌘N, ⌘\, ⌘1–9, ⌘↵, ⌘D, ⌘R, ?)
      theme.svelte.js       data-theme on <html>, localStorage `wts-theme`, xterm palette
      actions/
        activatable.js      keyboard-operable click targets
        trapFocus.js        overlay focus trap + focusablesIn
      stores/
        world.svelte.js     the SSE state layer — see "The two-half stream" below
        ui.svelte.js        view / selection / repo filter / dock view / split set
        notify.svelte.js    attention diffing, desktop notification, beep, waiting count
        overlays.svelte.js  which blocking overlay is up
        toasts.svelte.js    the toast stack
        dialog.svelte.js    uiDialog / uiConfirm / uiPrompt, promise-returning
      components/
        Terminal.svelte     one live terminal — xterm + socket + fit + ResizeObserver
        TopBar.svelte       brand / mux badge / Work-Fleet segment / global actions
        Modal.svelte        shared backdrop + focus trap + restore
        DialogHost.svelte   renders the queued dialog
        Palette.svelte      ⌘K command palette
        IntakeModal.svelte  new-session intake (free text / GitHub / GitLab / Asana)
        SettingsModal.svelte  connections & settings
        Toasts.svelte
        rail/               Rail, SessionCard
        dock/               Dock, DockHead, TabStrip, ServerBar, SplitPane, LogsPanel,
                            ReviewMount, InsightsMount
        fleet/              Fleet, FeatureRow, AgentRow, ServerRow, MainServerRow,
                            FeatureMenu
        review/             the Changes panel, mounted by dock/ReviewMount
          ReviewPanel.svelte   commit list + diff pane; owns fetching and staging
          CommitList.svelte    left column: uncommitted entries, then commits per repo
          DiffViewport.svelte  the windowed diff surface + keyboard navigation
          model.js             blocks → flat fixed-height item list (pure)
          api.js               the four review routes, typed
        insights/           transcript search + cost/token telemetry, mounted by
                            dock/InsightsMount
    routes/
      +layout.js            ssr = false, prerender = false
      +layout.svelte        theme, the SSE connection, global keys, every overlay
      +page.svelte          the single screen: Work (rail + dock) and Fleet
      review/+page.svelte   Changes-panel harness — session picker + <ReviewPanel>
      search/, usage/       insights harnesses
```


## Running it

```sh
npm install
npm run dev        # http://localhost:5273 — proxies /api and /ws to the daemon on 7788
npm run build      # → client/build
npm run preview    # http://localhost:5274 — the built bundle, same proxy
npm run check      # svelte-check
```

The daemon must already be running on 7788; this client never starts one. Note Vite binds
the IPv6 loopback, so use `localhost`, not `127.0.0.1`.

Work and Fleet are two views of **one** route, not two routes: switching must not tear
down the live terminal, and on a static SPA fallback a URL change would do exactly that.

## The two-half stream, and the trap in it

`GET /api/events` carries two named events, each a full replacement of one half of the
state payload:

| event | carries | rate |
| --- | --- | --- |
| `topology` | repos, worktrees, features, groups, sources, config | rarely (rescan / mutation) |
| `session-state` | `{ sessions, servers }` | every Claude hook — i.e. every tool call |

The trap: the topology half embeds a trimmed `{id,state,activity,muxName}` copy of the
driving session into every worktree row **and** every feature, frozen at the moment the
topology was built, while the authoritative list lives in the *other* half. Patch one
merged object in place and the `topology` frame — which arrives first on connect and
again on every rescan — overwrites those rows with stale (or, if you stitched into the
previous object, absent) decoration that no later frame restores.

So `stores/world.svelte.js` keeps **each half verbatim** and *derives* the world from the
pair on every frame, through the pure `stitchSessions()`. Frame order stops mattering.
This is the same semantics as `lastTopology` / `lastSessions` / `stitchSessions` in
`public/app.js`.

One consequence worth knowing before you write a component: **every session object is a
new object on every frame.** An `$effect` that reads one re-runs several times a second.
Derive a stable primitive (`const sessionId = $derived(session.id)`) and key the effect
off that — see the note in `dock/Dock.svelte`. Getting this wrong is not subtle: it
reopened the terminal WebSocket on every tool call.

## Rendering is keyed

`public/app.js` did `rail.innerHTML = ''` and rebuilt every card on every tick, which
destroyed focus, scroll position, selection and open menus several times a second.
Everything here is keyed — sessions by id, features by name, worktrees by path — and
updates in place. Measured against a live daemon: 12 `session-state` frames produced 12
text-node mutations, zero `.scard` element removals, an unchanged DOM node (verified by
an expando), retained keyboard focus and retained scroll position.

## Mount points for the other two panels

Two panels are built separately and are deliberately not imported anywhere in the shell:

| tab | mount | becomes |
| --- | --- | --- |
| ✎ Changes | `dock/ReviewMount.svelte` | `$lib/components/review/` — commits, diff, hunk staging |
| ◔ Insights | `dock/InsightsMount.svelte` | `$lib/components/insights/` — transcript search, cost/token telemetry |

Each mount is a placeholder whose header comment states the contract it guarantees
(when it renders, what `session` is, what height it owns). Integration is one import
swap per file; nothing else in the shell has to change.

## The boot token

Every `/api` request needs it — as `x-wts-token`, or as `?token=` on the two transports
that cannot set a header (`EventSource` and the terminal WebSocket).

- **Production**: `app.html` declares `window.WTS_TOKEN` with a `__WTS_TOKEN__`
  placeholder, and the daemon substitutes it when it serves the document — the mechanism
  `public/index.html` already uses, so no new server code is needed beyond pointing the
  existing injector at `client/build/index.html`. The placeholder must appear **exactly
  once** in `app.html`: the injector is a single `String.replace`.
- **Dev / preview**: there is no daemon in front of the document, so Vite `define`s the
  token read from `<stateDir>/token`. It is applied only for `command === 'serve'`, so a
  build can never write a token into `build/`.

The dev proxy also rewrites `Host` and `Origin` to the daemon's own address. Without
that, `server/security.js` refuses every dev request with `403 forbidden host` — the
allowlist is keyed to the daemon's bind port, and the dev server is on another one.

## Serving the build from the daemon

**Do not make this change from this branch** — `server/server.js` is being restructured
elsewhere. This is the change to apply at cutover.

The daemon already does the right thing structurally: it serves `/` through a handler
that injects the boot token, and mounts the static directory with `index: false` so the
un-injected `index.html` can never be served by the static middleware.

```js
// server/server.js, today
const INDEX = path.join(__dirname, '..', 'public', 'index.html');
app.get(['/', '/index.html'], (req, res) => {
  let html;
  try { html = fs.readFileSync(INDEX, 'utf8'); } catch { return res.status(500).send('index.html is missing'); }
  return res.type('html').set('Cache-Control', 'no-store').send(html.replace('__WTS_TOKEN__', cfg._token));
});
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));
```

**Two paths change, nothing else:**

```js
const INDEX = path.join(__dirname, '..', 'client', 'build', 'index.html');
…
app.use(express.static(path.join(__dirname, '..', 'client', 'build'), { index: false }));
```

`client/build/index.html` carries the same `__WTS_TOKEN__` placeholder that
`public/index.html` does, exactly once, so the existing `String.replace` and its
`Cache-Control: no-store` keep working verbatim. The token is never written to disk in
`build/` — Vite only injects one for `serve`.

Two things worth knowing before you flip it:

1. **Running both UIs at once.** Keeping the existing `public` static line *and* adding
   the client line does not do what it looks like: `/` is answered by the handler above,
   so whichever `INDEX` it points at is the UI you get. To serve them simultaneously,
   mount the new client under a prefix, give that prefix its own injecting handler, and
   set a matching `paths.base` in `svelte.config.js` — otherwise its assets resolve to
   `/_app/...` and 404. Until then, use `npm run dev` for the new UI.

2. **A second client route needs an SPA fallback**, and that fallback must inject the
   token too — a deep link that lands on the fallback is the document the tab boots
   from. Add this *after* every `/api` route so it cannot shadow them, reusing the same
   handler rather than `sendFile`:

   ```js
   app.get('*', (req, res) => res.type('html').set('Cache-Control', 'no-store')
     .send(fs.readFileSync(INDEX, 'utf8').replace('__WTS_TOKEN__', cfg._token)));
   ```

   `express@4` is what the repo pins, so the `'*'` pattern is correct; Express 5 would
   need `'/*splat'`.

The `/ws/term` WebSocket server attaches to the same `http.Server` and is unaffected —
`new WebSocketServer({ server, path: '/ws/term' })` intercepts the upgrade before Express
sees it, so static serving and the terminal socket cannot collide.

## Terminal.svelte

One component, instantiated once per pane. It replaces the duplicated `term`/`term2`,
`fit`/`fit2`, `ws`/`ws2`, `ro`/`ro2` globals and the parallel `openTerminal`/
`openSecondTerm`, `connectTermWS`/`connectSecondWS`, `sendResize`/`sendResize2`,
`destroyTerminal`/`closeSecondTerm` functions in `public/app.js`. Each instance privately
owns its xterm, WebSocket, fit addon and ResizeObserver, and tears all four down on
destroy, so neither pane can reach into the other's state.

```svelte
<Terminal {sessionId} />                                    <!-- primary -->
<Terminal {sessionId} pane="split" autofocus={false} />     <!-- split   -->
```

| prop | default | meaning |
| --- | --- | --- |
| `sessionId` | — | session id from `/api/state` |
| `pane` | `null` | `'split'` attaches the standalone `-split` session |
| `tab` | `null` | forwarded as the `tab` query param |
| `active` | `true` | false while hidden; suppresses fitting a zero-sized box |
| `autofocus` | `true` | take keyboard focus on connect — only one pane should |
| `maxRetries` | `5` | reconnect attempts, backing off 1s → 2s → 4s |
| `onstatus` | — | `'connecting' \| 'open' \| 'reconnecting' \| 'closed'` |

Methods via `bind:this`: `focus()`, `refit()`, `sendText(data)`.

Changing `sessionId`/`pane`/`tab` retargets in place — the socket is replaced and the
buffer reset, but the xterm instance and its renderer are reused, so the parent does not
need a `{#key}` wrapper to force a remount.

### Wire protocol (unchanged — see `wss.on('connection')` in `server/server.js`)

```
GET /ws/term?session=<id>[&pane=split][&tab=<i>]&cols=<n>&rows=<n>

client → server   raw bytes                     written straight to the pty
                  {"type":"resize","cols","rows"}
                  {"type":"input","data"}
server → client   raw pty output (text or binary frames)
```

The server parses each inbound text frame as JSON and falls back to writing it verbatim,
so `sendText()` uses the `input` frame rather than raw bytes — a payload that happens to
be valid JSON would otherwise be misread as a control message.

## Deliberate behaviour changes

Three places where this does not reproduce `public/app.js` exactly, because the original
was wrong:

- **Both terminals re-theme.** `toggleTheme()` only ever reassigned `term.options.theme`,
  so a split pane kept the old palette until it was destroyed.
- **The split pane reconnects.** Only the primary had the backoff chain; the split printed
  `[disconnected]` and stayed dead, so a daemon restart left it stranded.
- **The first theme toggle is not a no-op.** The old `toggleTheme()` inferred the current
  theme from `prefers-color-scheme` when `data-theme` was unset, but the CSS defaults to
  dark regardless of OS preference — so on a light-themed OS the first click "toggled"
  from an assumed light to dark while the page was already dark.

Also: fitting is skipped when the pane measures 0×0. The old ResizeObserver callback ran
`fit()` unconditionally, which on a hidden pane could push a nonsense geometry to the pty.

## The Changes panel (`lib/components/review/`)

`<ReviewPanel sessionId={id} />` is the whole panel: per repo, the branch's commits plus
an uncommitted entry on the left, a diff pane on the right. It owns its own fetching and
its own state and takes no store, so the shell can mount it with one prop. Develop it at
`/review` — that harness picks a session out of `/api/v1/state` and mounts nothing else.

### Two layouts, one payload

The daemon returns a structured diff on every file (`f.parsed`, see `server/diff.js`), so
neither layout re-parses patch text:

| layout | walks | line numbers |
| --- | --- | --- |
| unified | `hunk.lines` | `oldLine` / `newLine` on each line |
| side-by-side | `hunk.rows` — `left`/`right` index **into** `hunk.lines` | same objects, two columns |

### Why it is windowed

A commit here reaches a few thousand diff lines and a lockfile commit reaches far more;
side-by-side doubles the elements per row. `model.js` flattens every file header, group
label, hunk header and diff row in the selected commit into **one** item list whose
per-kind heights are known constants, and prefix-sums them. The viewport then binary-
searches `scrollTop` to the first visible item and draws only that slice plus an
overscan, absolutely positioned at their known offsets:

- the scroll canvas is sized once (total height from the prefix sum, width from the
  widest line in `ch`), so the scrollbar is correct from the first frame and does not
  twitch as rows recycle;
- cost per frame is O(window), independent of diff size.

The heights in `model.js`'s `H` are load-bearing — the CSS pins the same `height` on each
row, and changing one without the other makes the list drift from its own scrollbar.

The trade-off is real and deliberate: **off-screen rows are not in the DOM, so the
browser's own Ctrl-F cannot find them.** That is what the cursor, `n`/`p`/`[`/`]` and the
`f` file list are for.

### Side-by-side scrolls its two columns independently

Unified can size its canvas to the widest line and let the pane's own scrollbar do the
work. Side-by-side cannot. Two columns of a 260-column line is a 3000px+ canvas, so the
right-hand column starts past the edge of the pane — and scrolling to reach it takes the
left-hand column off the other side. One long line anywhere in the diff was enough to
make half of every row unreachable.

So in split the canvas is pinned to the pane, each column clips its own text, and each
carries its own offset (`--hxl` / `--hxr`) driven by its own scrollbar under the pane:

- **independent, not shared.** A long line on the right is a fact about the *new* file;
  dragging the unchanged left column sideways to read it is collateral damage. The two
  scrollbars are real focusable scroll containers, so arrow keys, `Home`/`End` and
  dragging all work with no code of ours.
- **vertical stays exactly in step for free** — both sides of a row are still one element
  in one scroller, so there is no second scroll position to synchronise.
- **the gutters do not move.** `.tx` is the clip box and `.txi` the thing that moves; a
  bare transform on the text slides it left *over* the line number, because the row does
  not clip. Reading a wide line while its number scrolls away is the bug this layout
  exists to avoid.
- widths are measured **per surface** in `model.js` over the whole diff (`cols`,
  `colsLeft`, `colsRight`), so each scroll range is fixed before the first frame and a
  long line on the right cannot invent scroll range on the left.

From the diff surface itself `←`/`→` walk both columns together — reading across a row is
the common case — and trackpad swipes go to whichever column the pointer is over.

### Keyboard

The diff surface is one focusable region with an internal cursor (announced through a
polite live region), not 10,000 tab stops.

| key | does |
| --- | --- |
| `↑` `↓` / `k` `j` | move the cursor one row |
| `PgUp` `PgDn` `Home` `End` | move a screen / to the ends |
| `n` `p` | next / previous hunk |
| `[` `]` | previous / next file |
| `←` `→` | side-by-side: pan both columns; unified: the pane's own horizontal scroll |
| `f` or `/` | the file list — type part of a path, `↑`/`↓` to pick, `↵` to land on its header |
| `↵` on a file header | collapse / expand that file |
| `s` `u` | stage / unstage — the hunk under the cursor, or every hunk on that side when the cursor is on a group or file header |
| `Esc` | return focus from a button (or the file list) to the surface |

Clicking the diff focuses it. That is not free: a bare `tabindex="0"` container does not
take focus from a click on a child, so without it a mouse user who clicked a hunk and
pressed `s` got nothing. The surface claims focus on pointerdown, deferred and only when
the press left focus on `<body>`, so it never takes it from a Stage button.

The file list is the panel's only overlay and therefore where `trapFocus` belongs: Tab
cycles the input and the results and never escapes to the diff behind the scrim. It is
built only while open — on a 100k-item list that scan is not free — and it reads the same
item list the viewport draws, so a jump is just a cursor move.

The commit list is a vertical toolbar with a roving tabindex: Tab enters and leaves it
once, `↑`/`↓` move within it.

### Staging: why the panel makes a second request

`GET /commit-detail?sha=uncommitted` is `git diff HEAD` — it merges staged and unstaged
changes into one picture. Staging acts on them separately, so stage buttons drawn on that
diff would be wrong the moment a file is half-staged. Each working file therefore also
gets `GET /hunks`, which splits the same changes into `unstaged` (index → worktree,
stageable) and `staged` (HEAD → index, unstageable), and the file renders from that: an
**Unstaged** group with a `Stage` button per hunk, a **Staged** group with `Unstage`, and
`Stage file` / `Unstage file` on the file header for whole-file staging. The merged diff
is shown for the moment before `/hunks` answers, labelled as such.

Every request sends `expect` — the `@@` header of each selected hunk. The daemon re-reads
the diff before applying, so without that guard a file changed on disk since the render
would stage the *wrong* hunk. On refusal the panel reloads that file and shows the
daemon's own message.

### States it handles

Binary, mode-only and combined (merge) diffs arrive flagged and render their reason
instead of an empty pane — hunk staging genuinely cannot work on them. So do: a clean
working tree, a branch with no commits, a file whose changes are now fully staged, and a
rename. git usually reports a rename as one `R` file; when its detection does not fire the
change arrives as an independent delete + add, and the two are re-linked for display only
(they still stage separately, because that is how the hunk layer sees them).

Renames also arrive **twice**. The daemon keys its file list by path and fills it from
both `git --numstat` and `--name-status`, which spell a rename differently — `--numstat`
prints the composite `README.md => docs.md` (or `{src => lib}/math.js`), `--name-status`
prints the new path. The composite half has no patch on any route, so the panel labels it
as a summary line and skips its `/hunks` request rather than drawing a file header with
nothing under it. If the daemon ever emits a real flag for this, `isRenameSummaryPath()`
in `model.js` is the one place to change.

### Not built here

The commit bar. `POST /sessions/:id/commit` runs `git add` before committing — with
`paths` it stages those paths, without it stages everything — so wiring it to a button
would silently discard a hunk-level index the user just built. Committing the index needs
either a `commit` that skips the add, or a plain stage route; until then this panel stages
and the terminal commits.
