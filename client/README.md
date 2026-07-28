# client — Worktree Studio frontend (SvelteKit)

The port of `public/` to SvelteKit. Built with `adapter-static` in SPA mode: the output
is plain files, and **the Express daemon in `server/` remains the only server**. There is
no Node adapter, no second process, no second port in production.

`public/` is untouched and still works. Both UIs can run side by side for the whole port.

## Layout

```
client/
  svelte.config.js          adapter-static, fallback: index.html
  vite.config.js            dev + preview proxy to the daemon on 127.0.0.1:7788
  src/
    app.html                pre-paint theme script (avoids a flash of the wrong theme)
    app.css                 design tokens + global primitives, ported from public/style.css
    lib/
      theme.svelte.js       data-theme on <html>, localStorage `wts-theme`, xterm palette
      actions/
        activatable.js      keyboard-operable click targets   (was activatable() in app.js)
        trapFocus.js        overlay focus trap + focusablesIn (was trapFocus()  in app.js)
      components/
        Terminal.svelte     one live terminal — xterm + socket + fit + ResizeObserver
        TopBar.svelte       brand / mux badge / theme toggle
        review/             the Changes panel (see below)
          ReviewPanel.svelte   commit list + diff pane; owns fetching and staging
          CommitList.svelte    left column: uncommitted entries, then commits per repo
          DiffViewport.svelte  the windowed diff surface + keyboard navigation
          model.js             blocks → flat fixed-height item list (pure)
          api.js               the four review routes, typed
    routes/
      +layout.js            ssr = false, prerender = false
      +layout.svelte        loads app.css, syncs the theme store
      +page.svelte          foundation harness (see below)
      review/+page.svelte   Changes-panel harness — session picker + <ReviewPanel>
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

`src/routes/+page.svelte` is a **foundation harness**, not the finished shell. The rail,
dock chrome, tab strips, fleet, settings and the SSE-backed state layer are deliberately
not built here — they depend on API surface that is still moving. The harness exists to
exercise the design tokens and the Terminal against a live daemon: it picks a session,
mounts the primary pane, and toggles a split pane.

## Serving the build from the daemon

**Do not make this change from this branch** — `server/server.js` is being restructured
elsewhere. This is the change to apply at integration time.

Today `server/server.js:162` is:

```js
app.use(express.static(path.join(__dirname, '..', 'public')));
```

**The one line**, at cutover — point it at the built client instead:

```js
app.use(express.static(path.join(__dirname, '..', 'client', 'build')));
```

That is genuinely all that is needed while the client has a single route, because
`build/index.html` is served at `/` and the hashed assets live under `/_app/`.

Two things worth knowing before you flip it:

1. **Running both UIs at once.** Keeping the existing `public` line *and* adding the
   client line after it does not work the way it looks like it should: both directories
   contain an `index.html`, so whichever is registered first wins `/` and the other UI
   becomes unreachable at the root. To serve them simultaneously, mount the new client
   under a prefix and set a matching `paths.base` in `svelte.config.js` — otherwise its
   assets resolve to `/_app/...` and 404. Until then, use `npm run dev` for the new UI.

2. **A second client route needs an SPA fallback.** As soon as the client routes to
   anything but `/`, a deep link or reload on that path hits Express, which knows nothing
   about client routes. Add this *after* every `/api` route so it cannot shadow them:

   ```js
   app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'client', 'build', 'index.html')));
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
