# 03 — Design, UX and language

Every design, interaction, accessibility and copy finding from the August 2026 review, deduped
across three reviewers. Line numbers are against commit `5ce2f4c`; another agent commits to this
repo, so re-grep the quoted string if a line is off by a few.

**Honest volume: 29 UX items and 12 language items.** Roughly half are trivial (a token value, a
string, an attribute). The expensive ones are UX-05, UX-10, UX-12 and UX-22, which are all facets
of the same problem — the one-bar consolidation shipped without an overflow strategy — and should
be scoped as one piece of work rather than four.

Provenance markers:

- **verified** — read in the source at the cited line, or computed from the exact token values.
- **inferred** — reasoned from the code; not rendered or measured in a browser. Confirm first.

Findings marked **(found N×)** were reported independently by that many reviewers. That is a
signal of importance, not redundancy.

Cross-track references: `STYLE-nn` items are in `01-code-style.md`, `BUG-nn` in
`02-functionality.md`.

---

## §1 — Fix these first

### UX-01 — "◉ Waiting" is inert for promoted features, and waiting agents never sort to the top of the rail

**Severity: critical · Effort: small · Verified · (found 2×)**

**Files:** `client/src/lib/stores/ui.svelte.ts:330`, `:541`;
`client/src/lib/components/TopBar.svelte:39-46`; `client/src/lib/stores/notify.svelte.ts:66`

`notify.waitingCount` (notify.svelte.ts:66) counts **every** session in the frame whose state is
`waiting`, so the badge, the desktop notification and the `● (n)` tab title are all correct. Both
consumers of that signal then filter on `r.kind === 'session'` — and in `railRows`, `kind:
'session'` means **unpromoted** sessions only. A promoted session is drawn as a `kind: 'feature'`
row carrying `feature.session`.

Two consequences:

- `ui.svelte.ts:330`, the rail sort key: `const waiting = (r) => (r.kind === 'session' ?
  r.session.state === 'waiting' : false)` returns false for every waiting agent that has a
  worktree, so it is sorted alphabetically among a dozen equally-active features. The comment
  above it ("Waiting now reliably occupies row one") is false for the normal case.
- `ui.svelte.ts:541`, `goToNextWaiting()`: `this.railRows.filter((r) => r.kind === 'session' &&
  r.session.state === 'waiting')` finds nothing, hits `if (!waiting.length) return false`, and
  `TopBar.svelte:39-46` ignores the return value. Clicking the badge does nothing at all, silently.

A worktree is the point of the product, so in steady state essentially every waiting agent is
promoted. The unit tests at `ui.test.ts:287` only exercise sessions with no `worktreePath`, which
is why this is green.

**Fix.** Add one accessor in `ui.svelte.ts` and use it in both places:

```ts
const sessionOf = (r: RailRow): Session | null =>
  r.kind === 'session' ? r.session : r.kind === 'feature' ? (r.feature.session ?? null) : null;
```

Line 330 becomes `const waiting = (r: RailRow) => sessionOf(r)?.state === 'waiting'`. Line 541
becomes `this.railRows.filter((r) => sessionOf(r)?.state === 'waiting')`, dispatching through
`goToSession(sessionOf(next)!.id)` for both kinds. Make the button honest about failure:
`onclick={() => { if (!ui.goToNextWaiting()) toast('Nothing is waiting right now'); }}`.

**Acceptance.** A new `ui.test.ts` case whose feature member carries a `waiting` session asserts
both that it is `railRows[0]` and that `goToNextWaiting()` selects it.

---

### UX-02 — First run on a machine without `~/code` dead-ends: 0 repos, an empty dropdown, `unknown repo ''`

**Severity: high · Effort: small · Verified**

**Files:** `server/config.ts:54`; `server/server.ts:1091`;
`client/src/lib/components/rail/Rail.svelte:68-69`;
`client/src/lib/components/IntakeModal.svelte:43`, `:118-122`, `:177`; `server/server.ts:453`

Four surfaces in a row, each implying the user did something wrong:

1. `config.ts:54` is `baseDirs: dash.baseDirs || ['~/code']` with no existence check — above a
   comment that calls it "a guess, not a convention".
2. The boot line (`server.ts:1091`) prints `(0 repos, mux=tmux)` and exits 0 with no warning.
3. `Rail.svelte:68` renders one unconditional empty state: "Nothing here yet. Start a session
   above, or promote one to create a worktree." It cannot distinguish "scanned, found nothing"
   from "nothing started yet", and the advice it gives is the step that cannot succeed.
4. `IntakeModal.svelte:43` is `if (!repo && world.repos.length) repo = world.repos[0].name`, so
   with zero repos `repo` stays `''`; the select at :118-122 renders no options; the submit button
   at :177 is `disabled={starting}` only, so it posts `{repo: ''}` and `server.ts:453` answers
   `unknown repo ''`.

Nothing anywhere names `baseDirs` or points at Settings. The only place in the client that
special-cases an empty repo list is `LogsPanel.svelte:109-110` ("no repos").

The adversarial pass rated this **medium** on the grounds that there is no data loss and the
remedy exists (Settings → baseDirs) and is merely unnamed. It is kept at high here because it is
the cheapest item on the list per unit of value: three small edits close a total first-run
dead end.

**Fix.** (a) At boot, if the scan yields 0 repos, log which directories were scanned and that
`baseDirs` is editable in config.json / Settings. (b) In `Rail.svelte`, branch the empty state on
`world.repos.length === 0` with copy naming baseDirs and a link to Settings. (c) In `IntakeModal`,
disable submit and show "No repos discovered — set your repo roots in Settings" when the select is
empty.

**Acceptance.** With `baseDirs` pointed at a nonexistent directory, the boot log, the rail and the
intake modal each name `baseDirs`, and the intake submit is disabled.

---

### UX-03 — The ▷ Run menu opens upward, but its button moved from the bottom of the window to the top of the dock

**Severity: high · Effort: trivial · Verified**

**Files:** `client/src/lib/components/RunConfigMenu.svelte:174-180`;
`client/src/lib/components/dock/DockHead.svelte:102`

`.sheet` is `bottom: calc(100% + 6px); right: 0; max-height: 60vh` — geometry written when the
ActionBar was a band pinned to the foot of the window. The ActionBar now renders inside
`.dock-head`, whose top edge sits roughly 44px (TopBar height) below the viewport top. A dropdown
anchored to that button's top edge and growing upward lays out at a negative viewport y for
anything taller than ~40px, i.e. every non-empty config list. Run configurations imported from
JetBrains/VS Code/Zed are a headline feature and the menu that surfaces them is unreachable, with
no scroll to recover it. Nothing about the code looks wrong on inspection — the identical idiom was
correct one commit ago.

**Fix.** `top: calc(100% + 6px)` instead of `bottom: calc(100% + 6px)`, keeping `right:0` and
`max-height:60vh`. Grep for `bottom: calc(100%` and check `AppMenu.svelte` and any other popover
that assumed a bottom anchor. `.dock` has `min-height:0` and no `overflow`, so a downward sheet at
`z-index:60` paints over the tab strip and terminal correctly. Land together with **STYLE-49**,
which hoists the shared `.sheet` rules.

**Acceptance.** With five or more run configurations, the open menu's bounding box is entirely
within the viewport.

---

### UX-04 — A selected feature card with a colour tag looks identical to an unselected one

**Severity: high · Effort: small · Verified**

**File:** `client/src/lib/components/rail/FeatureCard.svelte:148-157`

`.fcard` sets `background: var(--fc-wash, var(--panel))` and `.fcard.sel` sets `background:
var(--fc-wash, var(--elevated))`. When the feature has a colour tag `--fc-wash` is defined, so both
rules resolve to the **same** colour and selection changes the background not at all. The only
remaining difference is `border-color: var(--border)` → `var(--fc)` — and `--fc` is already painted
as a 3px inset edge on the same card, so selection adds a 1px ring in a colour the card is already
wearing. Measured, the washes are 1.04–1.13:1 against `--panel` in dark and 1.02–1.06:1 against the
page in light, so the wash is not a usable surface distinction on its own.

Opting into a colour tag makes a card's selection state *weaker* than an untagged one's.

**Fix.** Stop using background as the selection channel and give selection a dedicated one that
composes with the tag:

```css
.fcard.sel {
  border-color: var(--brand);
  background: color-mix(in srgb, var(--fc-wash, var(--panel)) 82%, var(--ink) 18%);
  box-shadow: inset 4px 0 0 var(--fc, var(--brand)), inset 0 0 0 1px var(--brand);
}
```

Keep `--brand` as the selection hue everywhere so selection reads as one thing regardless of tag;
the eight tag hues are already documented as clear of it.

**Acceptance.** For a colour-tagged feature, the selected and unselected card differ by at least
3:1 in some channel, measured on the actual rendered colours.

---

### UX-05 — The consolidated dock bar wraps, so selecting a different row changes the terminal's height

**Severity: high · Effort: medium · Inferred**

**Files:** `client/src/lib/components/dock/DockHead.svelte:111-113`;
`client/src/lib/components/ActionBar.svelte:208-211`;
`client/src/lib/components/dock/Dock.svelte:157-159`;
`client/src/lib/components/Terminal.svelte:83-86`, `:289-292`

`.dock-head` is `flex-wrap:wrap` with no min-height and now carries, in one row: status dot, title
(max-width 340px), worktree name (max-width 220px), a LinkChip per ticket plus one per repo
(max-width 260px each, including empty placeholders), a repo chip per repo with ports appended, and
the entire ActionBar — which for a promoted multi-repo feature is Stop stack + Restart stack +
Install deps(n) + one "Open ‹repo› ↗" per web app + ▷ Run + Open in editor(n) + ＋ repo + ✐ + ⏸ +
🗑. That is comfortably 1300–1600px of intrinsic width against roughly 1120px of dock on a 1440px
display with a 320px rail.

The wrap point is **state-dependent**: "Run stack" (1 button) becomes "Stop stack" + "Restart
stack" (2); ports appear inside repo chips when servers come up; "Install deps (2)" appears and
disappears. The ActionBar's own header comment states its reason for existing — "it occupies the
same space whether or not anything is selected" so the layout never shifts. Moving it inside a
wrapping header voided that. The terminal is `flex:1` beneath it with a ResizeObserver that refits
xterm, so every wrap change re-flows the tmux pane: reflowed scrollback, a resize round-trip to the
pty, and a visible jump — triggered not only by clicking a different feature but by a dev server
coming up on its own.

**Fix.** Make the bar a fixed height and the overflow explicit. `.dock-head { flex-wrap:nowrap;
min-height:52px; overflow:hidden; }`; wrap the identity group (dot + title + wtname) in a
`min-width:0` truncating flex child; put links + repo chips in a `flex:0 1 auto; overflow:hidden`
group; give ActionBar `flex:none; flex-wrap:nowrap`. Then bound the button count — see UX-22.

**Acceptance.** Switching selection between a running and a stopped feature does not change
`.dock-head`'s `offsetHeight`.

---

### UX-06 — Colour weight is inverted: the loudest control on screen is a routine, reversible verb

**Severity: high · Effort: small · Verified**

**Files:** `client/src/lib/components/ActionBar.svelte:121`, `:187`, `:198`;
`client/src/lib/components/TopBar.svelte:41-46`; `client/src/app.css:126-132`

`Stop stack` is `btn sm danger` — a solid `#e5484d` fill (app.css:126) — and is present on every
selected feature whose servers are up, i.e. the normal working state. `🗑 Delete session`
(ActionBar:187) and `Delete feature…` (ActionBar:198) are `btn sm ghost dangertext`: transparent
background, coloured text only. The top bar's `◉ Waiting` (TopBar:41) is `btn ghost`: transparent
border, `--muted` text, distinguished only by a 17px badge.

So the on-screen weight ranking is: stop a dev server (solid red) > start a stack (brand fill) >
delete a worktree permanently (quiet) > go to the agent that is blocked on you (quietest).
`app.css:128-130` already argues correctly that "green is a STATE, so actions are the brand hue";
the same argument applies to red and was not carried through.

**Fix.** Reserve solid `.danger` for irreversible actions. `Stop stack` (ActionBar:121) → `btn sm`
(neutral) — it is the counterpart of Run stack, not a destructive act. Promote the two delete
buttons from `ghost dangertext` to a bordered danger variant (`.btn.danger-outline {
border-color:var(--del); color:var(--del); background:transparent }`). Promote `◉ Waiting` to a
filled waiting-hue button (`background:var(--waiting-bg); border-color:var(--waiting);
color:var(--waiting); font-weight:700`) — it appears only when something is waiting, so it can
afford to shout. Land with **UX-08**, which fixes the danger colour's contrast.

**Acceptance.** No solid-fill red button remains on a reversible action; the only `.danger` users
are the two delete verbs.

---

## §2 — Colour, contrast and the visual system

### UX-07 — `--muted` and `--faint` are the same colour in dark mode (1.08:1), collapsing a three-tier hierarchy to two

**Severity: high · Effort: trivial · Verified**

**Files:** `client/src/app.css:14`; `client/src/lib/components/rail/FeatureCard.svelte:181-194`

Dark: `--muted:#8b95a3` and `--faint:#868f9e`. Computed contrast between them is 1.08:1
(relative-luminance delta 0.0245) — perceptually one colour. Light mode is fine at 1.32:1.
Components lean on the distinction constantly: FeatureCard's member row uses `--ink` for the repo,
`--muted` for the chip and `--faint` for the branch; SessionCard uses `--muted` for `.meta` and
`--faint` for `.act`; DockHead uses `--muted` for repo chips and `--faint` for the worktree name;
LinkChip uses `--ink` for the label and `--faint` for the sub.

The rail card is designed as a three-level readout — identity, secondary fact, tertiary fact — and
in the default theme it renders as two. That is the difference between scanning twelve cards and
reading them.

**Fix.** `--faint:#6e7887` (≈3.6:1 on `--panel`, still legible for a tertiary label, ~1.5:1 apart
from `--muted`). Then audit the four call sites: the `⌥digit` chip (FeatureCard:165-166, `--faint`
at 10px with `opacity:.75`) should move to `--muted` and drop the opacity — it is a keyboard target,
not decoration.

**Acceptance.** `--muted` and `--faint` differ by ≥1.4:1 in both themes.

---

### UX-08 — Light theme: the status pills — the app's core state vocabulary — fail WCAG AA, and `.danger` fails in both themes

**Severity: high · Effort: small · Verified · (found 2×)**

**Files:** `client/src/app.css:65-66`, `:126-127`, `:147-149`;
`client/src/lib/components/rail/FeatureCard.svelte:175-178`;
`client/src/lib/components/ActionBar.svelte:217`

Computed from the exact token values, light palette, all at 11.5px monospace (normal size, needs
4.5:1):

| Pair | Ratio |
|---|---|
| `.pill.waiting` — `#b87503` on `#f8ead0` | **3.16:1** |
| `.pill.done` — `#177f45` on `#d3edda` | **4.06:1** |
| `.pill.stopped` — `#5f6775` on `#e4e1d9` | **4.36:1** |
| `.btn.danger` — `#ffffff` on `#e5484d` (both themes) | **3.91:1** |
| `.dangertext` — `#e5484d` on the light panel | **3.91:1** |

`.pill.nodeps` and `.pill.nostart` (FeatureCard:175-178) reuse the waiting pair and fail
identically; the amber is also the `.streamwarn` banner colour. The dark palette is clean —
every pair measured there is ≥4.90:1 — so this is specifically the light retune not having been
re-measured. The waiting pill is the one label the whole rail is optimised to make findable, and in
light mode it is the least legible text on the card.

**Fix.** Darken the foregrounds, keep the washes: `--waiting:#8a5602` (4.72:1 on `#f8ead0`),
`--done:#0f6236` (5.6:1 on `#d3edda`), `--faint:#565e6c` for the stopped pill (4.61:1 on
`#e4e1d9`). For danger, introduce `--danger:#c1272d` and make `.btn.danger` `background:var(--danger);
color:#fff` (5.4:1); replace the two hardcoded `#e5484d` literals (app.css:126-127,
ActionBar.svelte:217) with `var(--del)`, which already measures 6.13:1 light / 5.16:1 dark. While
here, re-check `--brand` on `--bg`: `#c1521f` on `#e9e6e0` is 3.75:1 — fine for the 13.5px `.btn`,
marginal for the 11.5px `.pr` and `.link` labels.

**Acceptance.** Every pill/button foreground:background pair measures ≥4.5:1 in both themes.

---

### UX-09 — The command palette's selected row is invisible: 1.07:1 against the panel

**Severity: high · Effort: trivial · Verified**

**File:** `client/src/lib/components/Palette.svelte:162` (`.pcmd.on`), with the list at `:130`, `:142`

`.pcmd.on { background: var(--elevated); }` is the **only** indicator of which row Enter will run.
Dark: `#1b212a` on the modal's `#161b22` panel = 1.07:1. Light: `#f3f0ea` on `#ffffff` = 1.14:1.
WCAG requires 3:1 for a non-text state indicator. ⌘K is the primary navigation verb; arrowing down
a list whose highlight is imperceptible means pressing Enter on whatever you hope is selected.

The correct treatment already exists three files away — `DiffViewport.svelte:714` `.jumprow.at` is
`background:var(--elevated); box-shadow:inset 2px 0 0 var(--brand)`.

**Fix.** `.pcmd.on { background:var(--elevated); box-shadow:inset 2px 0 0 var(--brand); }`. Do it
in the same edit as UX-15, which adds the semantic counterpart.

**Acceptance.** The selected palette row differs from its neighbours by ≥3:1 on some channel.

---

### UX-12 — No type, space or radius scale: 20 hardcoded font sizes, and `.src`/`.chip` each defined several times with different values

**Severity: medium · Effort: medium · Verified**

**Files:** `client/src/app.css:146-164`; `client/src/lib/components/rail/FeatureCard.svelte:196-199`;
`client/src/lib/components/rail/MainServerCard.svelte:48-49`;
`client/src/lib/components/dock/FeaturePane.svelte:182`;
`client/src/lib/components/LinkChip.svelte:56-58`;
`client/src/lib/components/dock/DockHead.svelte:119`

Grepping every `font-size` under `client/src` yields 20 distinct values: 9.5, 10, 10.5, 11, 11.5,
12, 12.5, 13, 13.5, 14, 14.5, 15, 16, 17, 19, 20, 22, 26, 40, 52px — half-point steps with no ratio
between them. `--sans`, `--mono` and every colour are tokens; nothing about size, spacing or radius
is. The consequence is that named primitives have forked:

- `.src` is defined **four** times: app.css:158 (10.5px, `1px 6px`, radius 5); FeatureCard:198
  (10px, `1px 5px`); FeaturePane:182 (10.5px, `1px 6px`); MainServerCard:48 (10px, `1px 5px`).
- `.chip` is defined **twice** with different radii: app.css:156 (radius 20) and LinkChip:57
  (radius 6, max-width 260px, scoped so it wins), plus three near-identical siblings —
  `.repochip2` (radius 6, pad `2px 7px`), `.portchip` (radius 6, pad `2px 8px`), `.badge` (radius
  999, pad `2px 8px`).
- Gaps in use across the same handful of components: 3, 5, 6, 7, 8, 9, 10, 12px.

Three chips sitting in the same 40px of the dock bar have three different radii and three different
vertical paddings, so their optical baselines disagree and the row looks assembled rather than
designed. And because `.src` means four sizes depending on which component you are in, a card and
the pane describing the same feature disagree about how big "manual" is.

**Fix.** Add to `:root` in app.css: `--fs-xs:10.5px; --fs-sm:11.5px; --fs-md:12.5px;
--fs-base:13.5px; --fs-lg:16px; --fs-xl:20px;`, `--sp-1:4px … --sp-5:20px`, `--r-sm:6px;
--r-md:10px; --r-pill:999px`. Then (a) delete the three duplicate `.src` blocks so app.css wins;
(b) unify `.chip` on `--r-sm` and drop the radius-20 variant; (c) make `.repochip2` and `.portchip`
extend `.chip` rather than restate it. Mechanical, component by component. **STYLE-57** and
**STYLE-60** both depend on this landing first.

**Acceptance.** No `font-size`, `border-radius` or padding literal outside `:root` in app.css;
`.src` and `.chip` each have exactly one definition.

---

### UX-24 — Motion is spent on `working` (nothing needed) instead of `waiting` (you are blocked)

**Severity: medium · Effort: trivial · Verified**

**Files:** `client/src/app.css:142-144`; `client/src/lib/components/dock/TabStrip.svelte:296-299`

`.dot.working` pulses; `.dot.waiting` is static. Working is the resting productive state — across
twelve concurrent features it is the majority state, so the rail shows a field of pulsing purple
dots. Waiting is the exception state that the rail sort, the badge, the tab title, a desktop
notification and a beep all exist to surface, and it is the only one of the two that does not move.
Motion is the strongest pre-attentive channel available and it is allocated to the signal that
requires no action. It also means the rail is never visually still during ordinary work.

**Fix.** Move the animation: `.dot.waiting { animation: pulse 1.4s ease-in-out infinite; }`, drop
it from `.dot.working`, and extend the existing `prefers-reduced-motion` guard to cover
`.dot.waiting`. If `working` needs to look alive, give it something slower and non-competing (a 3s
opacity float between 1 and .7). `TabStrip`'s `.cbadge.live` pulse is fine as-is — a run in flight
is genuinely transient.

**Acceptance.** Only `waiting` (and the transient run badge) animate; reduced-motion still disables
both.

---

### UX-25 — Colour is the only channel for agent state in the dock, and for add/delete in side-by-side diff

**Severity: medium · Effort: small · Verified**

**Files:** `client/src/app.css:138-141`; `client/src/lib/components/dock/DockHead.svelte:65`;
`client/src/lib/components/dock/TabStrip.svelte:204-206`;
`client/src/lib/components/review/DiffViewport.svelte:479-488`

Two instances.

1. The `.dot` vocabulary is five identical 9px circles separated only by hue — working `#9b8cf5`,
   waiting `#e5ab3c`, done `#4bb96a`, idle `#5d6673`, stopped `#868f9e`. In FeatureCard a text pill
   accompanies it, but only for `working`/`waiting` (the `notable` guard at line 78); in DockHead
   (:65) and the tab strip (:205) the dot appears with **no text at all** — a `title` attribute is
   the only fallback, and titles are not exposed to touch, not reliably to AT, and need a hover.
   Waiting-amber vs done-green vs stopped-grey is precisely the discrimination a protan or deutan
   viewer cannot make.
2. In side-by-side diff the `+`/`−` marker column (`.mk`) exists only on `.row.uni`. `.row.split`
   distinguishes an added line from a deleted one purely by `--add-bg` vs `--del-bg` background and
   `--add`/`--del` text colour — which is the entire semantic content of that view.

**Fix.** (1) Add a shape channel to `.dot` via pseudo-elements: `.dot.waiting::after` a centre dot,
`.dot.done` a thin inset check, `.dot.stopped` a hollow ring (`background:transparent; box-shadow:
inset 0 0 0 2px var(--faint)`), keeping `working` as the only animated one (after UX-24, waiting).
Cheapest alternative that also fixes AT: give every `.dot` `role="img" aria-label="{state}"` and
render the state word next to it in DockHead. (2) In DiffViewport, emit the marker inside each
`.side`: `<span class="mk" aria-hidden="true">{it.type === 'del' && it.left ? '−' : it.type ===
'add' && it.right ? '+' : ' '}</span>` with `.row.split .side .mk { width:12px; flex:none;
text-align:center; }`. **STYLE-57** lands after this.

**Acceptance.** Every agent state is distinguishable in greyscale; split diff rows carry a `+`/`−`.

---

### UX-27 — The feature colour tag is carried almost entirely by a 3px edge, and that edge is contested by "servers up"

**Severity: low · Effort: small · Verified**

**Files:** `client/src/app.css:25-32`, `:73-80`;
`client/src/lib/components/rail/FeatureCard.svelte:148-157`

Measured, the washes are 1.04–1.13:1 against `--panel` in dark and 1.02–1.06:1 against the page in
light — below the threshold at which a tint reads as a distinct surface at card size. So the tag is
effectively the 3px inset edge alone. Meanwhile `.fcard.running` reuses that same edge (`inset 3px
0 0 var(--fc, var(--done))`), so a tagged feature whose servers are up shows its tag colour and no
green at all. The comment at FeatureCard:154-156 acknowledges this and defers to the port numbers
on the member rows — defensible, but it leaves the tag as the only feature-level signal on a 3px
sliver, and grouping across twelve cards is the one job the tag has.

**Fix.** Commit or drop. Committing: raise the dark washes to ~1.35–1.5:1 against `--panel` (e.g.
`--f-teal-wash:#173a38`, `--f-sky-wash:#132e42`) and the light washes to ~1.15:1 against `#e9e6e0`.
Dropping: remove `--fc-wash` from `.fcard`'s background and widen the identity edge to 4–5px, which
reads reliably at rail width. Either way, give "servers up" its own channel independent of the tag
— a small `⇅` glyph beside the dot, or tint only the card's port numbers — so the two facts stop
sharing three pixels. **Sequence after UX-04**, which changes what selection does to the same
background.

**Acceptance.** Tag hue and "servers running" are readable independently on the same card.

---

## §3 — Layout, overflow and structure

### UX-10 — The dock header is two different components with different information, so switching selection kind reshapes the identity block

**Severity: medium · Effort: medium · Verified**

**Files:** `client/src/lib/components/dock/Dock.svelte:89-93`, `:104-109`, `:157-159`;
`client/src/lib/components/dock/DockHead.svelte:64-104`, `:111-113`

A selected session gets `.dock-head`: status dot + 16px title + worktree name + source chip + links
+ one repo chip per repo with ports + verbs. A selected feature gets `.dockbar`: 16px name + verbs
— no dot, no repo chips, no ports, no links. A main-checkout server gets a third variant: name +
the literal string "main checkout" + verbs. The three are styled by duplicated CSS: `.dockbar`
(Dock.svelte:157-159) is a hand-copy of `.dock-head` (DockHead.svelte:111-113), including the
`inset 4px 0 0 var(--fc)` edge (also **STYLE-56**).

The bar is the app's answer to "what am I looking at", and it answers in three vocabularies at
three heights. Clicking down a rail of mixed features and sessions makes the header grow and shrink,
which re-flows the terminal (UX-05) and gives the eye nothing stable to anchor on.

**Fix.** Extract one `IdentityBar.svelte` owning the row's CSS and taking a normalised shape —
`{ state, title, subtitle, links, repos }` — built by a small adapter per selection kind. Feature:
state from `feature.session?.state ?? (anyRunning ? 'done' : 'idle')`, repos from
`liveMembers(feature)` with their ports, links from `world.linksFor(feature)`. Main server: state
`'done'`, one repo chip with ports, subtitle "main checkout". `Dock.svelte` then renders
`<IdentityBar …><ActionBar /></IdentityBar>` in all three branches and `.dockbar` disappears. This
supersedes **STYLE-56** and closes **UX-11**.

**Acceptance.** One component renders the identity bar for all three selection kinds; `.dockbar` is
deleted.

---

### UX-11 — Tracker and merge-request links exist only when a session is selected — the exact bug `links.ts` says it fixed

**Severity: medium · Effort: small · Verified**

**Files:** `client/src/lib/components/dock/Dock.svelte:87-94`;
`client/src/lib/components/dock/FeaturePane.svelte:71-83`;
`client/src/lib/components/LinkChip.svelte:6-9`; `server/links.ts:9-14`

`world.linksFor(feature)` is keyed on the **feature** (world.svelte.ts:232), and `server/links.ts:9-14`
states the point: "a link outlives the session that produced it… a feature with no session had
neither." But `LinkChip` is imported in exactly one file — `DockHead.svelte` — which renders only
for a selected session. Select a sessionless feature and `Dock.svelte:89-93` draws a bare
`.dockbar` with the feature name and verbs; `FeaturePane` draws repos, branches and commits but no
ticket and no MR chips. The rail's `FeatureCard` derives `prTags` from the same link list but shows
only the trailing token (`!1907`) and never the ticket.

The most common reason to open a worktree you are not actively working in is to check its merge
request or its ticket — and that is exactly the selection where the links disappear, while the
ActionBar still offers "Create PR / MR" with no way to see whether one exists.

**Fix.** Render the links in `Dock.svelte`'s `.dockbar` branch the way DockHead does
(`{@const links = world.linksFor(feature)}` + the same `{#if links.length}` block). Better: fold
this into **UX-10**'s `IdentityBar`, which solves it structurally.

**Acceptance.** Selecting a sessionless feature shows its ticket and MR chips.

---

### UX-22 — The single dock bar has no overflow strategy, and the shell does not survive a narrow window

**Severity: medium · Effort: medium · Inferred**

**Files:** `client/src/lib/components/dock/DockHead.svelte:111-113`;
`client/src/lib/components/ActionBar.svelte:208-211`; `client/src/routes/+page.svelte:71`;
`client/src/lib/components/TopBar.svelte:64`

The one-bar consolidation put identity (dot, title, worktree name, link chips, one repo chip per
repo with ports) and up to eight action buttons in a single `display:flex; flex-wrap:wrap` row,
with the ActionBar itself also wrapping. There is no overflow menu, no priority ordering, no
max-height. `.main` is `grid-template-columns: var(--rail-w) auto 1fr` where the first track is a
fixed length with a 250px floor (`RAIL_MIN`) and no collapse control; `.topbar` does not set
`flex-wrap` and `.brand` has no `min-width:0`. So as the window narrows the dock column shrinks
toward its min-content, the header wraps to three, four, five rows — each 100% of the header's
width, all of it taken from `.term-area` below — and below roughly 900px the page starts scrolling
horizontally instead. On a half-width window (the natural shape beside an editor) a promoted
multi-repo session shows a header taller than the terminal it heads, and there is no way to reclaim
the space.

**Fix.** Three bounded changes. (1) Give `.dock-head` `container-type: inline-size` and at
`@container (max-width: 720px)` hide `.repochips` and `.wtname` — both are available in FeaturePane
and the rail card. (2) Give the ActionBar an overflow: keep the state-dependent stack verb, "Open
in editor" and ▷ Run inline; move ＋repo, ✐, ▶︎/⏸︎ and 🗑 behind a `⋯` button reusing AppMenu's
popover markup, shown when the count would exceed four. (3) `grid-template-columns: minmax(0,
var(--rail-w)) auto minmax(0, 1fr)`; `flex-wrap: wrap` on `.topbar`; `min-width: 0` on `.brand`;
`@media (max-width: 760px) { --rail-w: 220px }`. Do this **with UX-05** — they are the same defect.

**Acceptance.** At 900px viewport width with a promoted three-repo session selected, the page does
not scroll horizontally and `.dock-head` is a single row.

---

### UX-14 — Cold start shows the wrong empty states: `world.connected` exists and has no consumers

**Severity: high · Effort: small · Verified**

**Files:** `client/src/lib/stores/world.svelte.ts:162`;
`client/src/lib/components/rail/Rail.svelte:66-71`;
`client/src/lib/components/dock/Dock.svelte:118-131`

`world.connected` is set true on the first SSE frame and, verified by grep, has **zero** consumers
anywhere in the client. The rail renders `{#if !rows.length}` → "Nothing here yet. Start a session
above, or promote one to create a worktree." and the dock renders the full "No session selected"
empty state with its CTA buttons. Both are unconditionally true during the window between page load
and the first `topology` frame; there is no loading state anywhere in the shell.

On every reload, a user with twelve live features is told for a beat that they have none and
invited to create one. `Dock.svelte` already got the analogous case exactly right for
`ui.selectionPending` ("Starting the session…", with a comment explaining why the empty state was
wrong there); the reasoning was never applied to boot.

**Fix.** Gate both on `world.connected`: in `Rail.svelte`, `{#if !world.connected}` →
"Connecting to the daemon…", `{:else if !rows.length}` → the existing copy (as amended by UX-02).
In `Dock.svelte`, add a `{:else if !world.connected}` branch before `{:else if !session}` reusing
the `.empty` block with "Connecting…" / "Waiting for the first frame from the daemon."
`world.streamError` is already rendered at `+page.svelte:60` and is correct — keep it, and consider
`role="status"`.

**Acceptance.** With the daemon stopped, the rail and dock say "connecting", not "nothing here".

---

## §4 — Keyboard and interaction

### UX-13 — A terminal tab cannot be closed from the keyboard at all

**Severity: high · Effort: small · Verified**

**Files:** `client/src/lib/components/dock/TabStrip.svelte:210-219`, `:144-159`

The close control is `<span role="button" tabindex="-1" onkeydown={…Enter/Space…}>✕</span>` nested
inside the tab's `<button>`. The comment directly above it says "A real button, so it is reachable
and announced" — it is neither: `tabindex="-1"` removes it from the tab order, so its keydown
handler can never fire. It is also interactive content inside a `<button>`, which is invalid HTML.
`onTabKeydown` binds F2 (rename) and ←/→/Home/End (roving focus) but no close key, and the only
other close path is middle-click. Tabs accumulate — every run configuration and every ＋ press
creates one, and the strip caps each at 190px.

**Fix.** (a) Bind a close key in `onTabKeydown`. **Do not use ⌘W** — in a browser that closes the
window. Use `Delete`/`Backspace` on a focused tab, guarded by `tabs.length > 1`, and add the row to
`ROWS` in `shortcuts.svelte.ts`. (b) Fix the markup: either lift the ✕ out of the `<button>` so the
tab becomes a `<span class="tab">` containing a label button and a real close `<button>`, or keep
one button and demote the ✕ to `aria-hidden="true"` decoration. Do not leave a `role="button"` with
`tabindex="-1"` in place.

**Acceptance.** A tab can be closed with the keyboard alone; no interactive element is nested
inside a `<button>`.

---

### UX-17 — The palette advertises ⌘↵ for Promote, which is unbound and means something else; Intake promises ↵ and does not listen

**Severity: high · Effort: trivial · Verified · (found 2×)**

**Files:** `client/src/lib/components/Palette.svelte:67`; `client/src/lib/shortcuts.svelte.ts:49`,
`:144-152`; `client/src/lib/components/Terminal.svelte:250`;
`client/src/lib/components/IntakeModal.svelte:177`

`Palette.svelte:67` renders `add('⤴', 'Promote current to worktree', '⌘↵', …)` — the `sub` slot is
where every other row prints its real binding. ⌘↵ is **not** bound to Promote:
`shortcuts.svelte.ts:144-152` documents at length that the binding was removed because ⌘↵ belongs
to the terminal, and `Terminal.svelte:250` maps `meta:Enter` to LF. The cheatsheet (ROWS line 49)
correctly says "New line in the terminal". So one screen says ⌘↵ promotes and another says it
inserts a newline; pressing it does the latter.

Separately, `IntakeModal`'s primary button is labelled `Start session ↵`, but nothing in that
component listens for Enter and the modal is not a `<form>`. With focus in the textarea — which the
component focuses on open — Enter inserts a newline.

**Fix.** `Palette.svelte:67` — set `sub` to `''`; Promote has no binding and the palette row *is*
the affordance. `IntakeModal` — either make ⌘↵ real (`onkeydown` on the modal content root:
`if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); start(); }`) and relabel
the button `Start session ⌘↵`, or drop the glyph. Plain Enter must stay a newline: the primary
field is a multi-line textarea. Then add the row to `ROWS`. Fix alongside **STYLE-28**, which makes
one key table the source for all three surfaces.

**Acceptance.** Every key printed in the palette or on a button performs the advertised action.

---

### UX-20 — ⌘D and ⌘R silently do nothing when a sessionless feature is selected, and swallow the browser default while doing it

**Severity: medium · Effort: trivial · Verified**

**File:** `client/src/lib/shortcuts.svelte.ts:153-166`

Both branches read `const s = ui.selected`, which is non-null only for a **session** selection. A
feature row without an agent — a first-class rail selection with its own dock pane and its own
ActionBar verbs, including a working "Run stack" — yields `s === null`, so ⌘R calls
`e.preventDefault()` and returns having done nothing. ⌘D behaves the same. The unconditional
preventDefault is deliberate and correct (documented at lines 24-27), but combined with the null
selection it produces the worst outcome: the browser reload is suppressed, the app action does not
run, and nothing is said. `runStack` takes a feature name and the ActionBar already resolves the
target from either side (`ui.selectedFeature || sessionFeature`) — the capability exists, the
shortcut just does not reach it.

**Fix.** Resolve the same target the ActionBar does: `const target = ui.selectedFeature?.name ??
(ui.selected?.feature ?? null);` then ⌘R → `if (target) runStack(target); else toast('Select a
feature or session with a worktree to run its dev servers.')`. Keep ⌘D's session requirement (there
is no diff without one) but say so: `toast('Review needs a promoted session.')`.

**Acceptance.** `shortcuts.test.ts` covers a feature-selected case for both keys; neither is a
silent no-op.

---

### UX-23 — The keyboard cheatsheet is duplicated, factually wrong in one row, and missing five real bindings

**Severity: medium · Effort: trivial · Verified**

**Files:** `client/src/lib/shortcuts.svelte.ts:43-56`;
`client/src/lib/components/Terminal.svelte:246-253`;
`client/src/lib/components/dock/TabStrip.svelte:145`

`ROWS` contains `⇧↵` twice — line 50 ("New line in the terminal") and line 54 ("New line in the
terminal (sent as ESC+CR)"). The second is wrong twice over: it duplicates the first, and
`Terminal.svelte` sends LF (`'\n'`), with a comment at lines 214-224 explaining that ESC+CR was
tried and specifically did **not** work. Missing entirely: `⌘⌫` (bound to ^U, Terminal:249),
`⌥←`/`⌥→` (ESC b / ESC f, Terminal:251-252), `F2` (rename tab, TabStrip:145), middle-click-to-close,
and `Escape` — the most consequential key in the app (interrupts the agent when nothing is open,
closes the topmost overlay otherwise).

**Inferred, verify before acting:** ⌘N cannot be intercepted by a page in Chrome or Safari (it is a
browser-level new-window command), so the advertised ⌘N probably never reaches `handleShortcut` in
the two likeliest browsers.

**Fix.** Delete ROWS line 54. Add `['⌘⌫','Delete to start of line in the terminal']`,
`['⌥←/→','Move by word in the terminal']`, `['F2','Rename the current terminal tab']`,
`['esc','Interrupt the agent — or close the topmost overlay']`, and the tab-close key from UX-13.
Group the rows with a section break between app-level and terminal-level keys. For ⌘N: **verify in
the target browser first**; only if it genuinely does not arrive, re-bind to ⌘⇧N and update ROWS
and `Palette.svelte:65`. Land with **STYLE-28**.

**Acceptance.** Every binding in `handleShortcut` and `Terminal.BINDINGS` appears exactly once in
the cheatsheet, and nothing appears that is not bound.

---

### UX-16 — Escape or a stray backdrop click silently discards the entire settings form

**Severity: medium · Effort: medium · Verified**

**Files:** `client/src/lib/components/SettingsModal.svelte:176`;
`client/src/lib/components/Modal.svelte:25-28`; `client/src/lib/stores/overlays.svelte.ts:66-74`

`SettingsModal` is a large multi-section form — repo roots, dev-server commands, editor commands,
run configurations, feature groups, three API tokens — held entirely in local `$state` and written
only by `save()`. `Modal.svelte`'s backdrop handler calls `onclose` on any click landing outside the
panel, and `overlays.escape()` closes `settings` unconditionally. Neither path checks whether
anything was edited; there is no dirty tracking. The file's own header notes the server treats these
lists as **full replacements**, which raises the stakes: this is where you reconstruct a config, and
losing it means retyping tokens. Every other destructive action in this app confirms; this one does
not even announce that it happened.

**Fix.** Snapshot the serialised form after load (`pristine = JSON.stringify(formValue)`) and derive
`dirty`. Route close through a guard: `async function requestClose() { if (dirty && !(await
uiConfirm('Discard your unsaved settings changes?', { title:'Unsaved changes', okLabel:'Discard',
danger:true }))) return; overlays.closeSettings(); }`. For Escape, have `overlays.escape()` consult
a registered guard, or minimally make Escape a no-op while dirty and rely on the explicit Close
button.

**Acceptance.** Escape and a backdrop click on a dirty settings form prompt before discarding.

---

### UX-19 — `role="menu"` popovers with no menu keyboard behaviour and no focus restore

**Severity: medium · Effort: medium · Verified**

**Files:** `client/src/lib/components/AppMenu.svelte:70-97`, `:39-55`;
`client/src/lib/components/RunConfigMenu.svelte:135-167`

Both popovers declare `role="menu"` with `role="menuitem"` children and suppress the resulting lint.
Neither implements the pattern: opening does not move focus into the sheet, ↑/↓/Home/End do nothing,
and there is no focus restore — Escape closes via a document capture listener that just sets `open =
false`, so if focus was on a menuitem that node unmounts and focus falls to `<body>`, dumping the
user at the start of the tab order. `RunConfigMenu` is worse: its sheet opens upward while sitting
after the trigger in DOM order, so Tab moves visually backwards (UX-03 fixes the direction).
Neither sets `overlays.any`, so global shortcuts stay live over an open menu.

The ⋮ menu is where Settings, the theme toggle, the cheatsheet and "Stop all servers" live — four
keyboard-only-discoverable capabilities.

**Fix.** Either implement the pattern or drop the roles. Implementing (~25 shared lines): extract a
`menuKeys` action that focuses the first `[role=menuitem]` on mount, handles ArrowDown/ArrowUp
(wrapping) and Home/End, and restores focus to a `trigger` element on destroy. Apply
`use:menuKeys={{ trigger: triggerEl }}` to both sheets. Dropping: remove the roles and leave a div
of buttons (natural Tab order, correct announcement) — but still restore focus to the trigger.
Land with **STYLE-49**, which extracts the shared dismiss effect these both duplicate.

**Acceptance.** Closing either menu with Escape returns focus to its trigger button.

---

### UX-15 — The command palette is a listbox rendered as unlabelled divs; nothing announces the highlight

**Severity: medium · Effort: small · Verified**

**File:** `client/src/lib/components/Palette.svelte:116-149`, `:130`, `:142`

Rows are `<div class="pcmd" onclick={…} onmousemove={…}>` with two suppressed a11y lint rules. The
container is `role="search"`; there is no `role="listbox"`, no `role="option"`, no `aria-selected`,
no `aria-activedescendant` on the input, and no `aria-expanded`/`aria-controls`. The `hi` index
drives only a CSS class. A screen-reader user gets a text field with no announced results and no
announced selection: arrowing produces silence and Enter runs something unnamed.
`DiffViewport`'s file-jump — a strictly simpler version of the same widget — does it correctly at
lines 558-573 with real `<button>` rows.

**Fix.** Copy the jump list. `role="listbox" id="palette-list" aria-label="Results"` on
`.palette-list`; each `.pcmd` gets `role="option" aria-selected={hi === idx} id="pcmd-{idx}"`; the
input gets `role="combobox" aria-expanded="true" aria-controls="palette-list"
aria-activedescendant="pcmd-{hi}"`. Drop the two `svelte-ignore` comments. Make `.psec` headings
`role="presentation"`, or wrap each section in a labelled `role="group"`. Do it in the same edit as
**UX-09**.

**Acceptance.** Arrowing the palette announces each option and its selected state.

---

### UX-18 — Toasts are the only feedback channel, and they are polite-only, undismissable and auto-expiring

**Severity: medium · Effort: small · Verified**

**Files:** `client/src/lib/components/Toasts.svelte:7-10`;
`client/src/lib/stores/toasts.svelte.ts:17`; `client/src/lib/ops.svelte.ts:494-502`

Every mutating op reports exclusively through `toast()`. The stack is `aria-live="polite"` for both
kinds, so an error and a success are announced identically and with equal urgency; errors should be
assertive or `role="alert"` (the app already uses `role="alert"` correctly for the staging banner at
`ReviewPanel.svelte:305`). The toast has no close button and no hover-to-persist, and `push()`
hard-codes a 3.2s / 6s `setTimeout` with no pause. Some messages are long and load-bearing:
`startResult` produces "Started 1/3 (1 failed). Skipped api — dependencies not installed" — a
sentence you need to finish reading and cannot get back. The most information-dense messages in the
app appear in the shortest-lived container, with no history.

**Fix.** In `Toasts.svelte`, split the stack: keep `aria-live="polite"` for normal toasts and render
error toasts into a sibling `aria-live="assertive"` region (or give the error toast `role="alert"`).
Add a per-toast dismiss button (`.toast` already has `pointer-events:auto`). In
`toasts.svelte.ts`, store the timer id on the Toast and expose `pause(id)`/`resume(id)`, wired to
`onmouseenter`/`onmouseleave` on `.toast-stack`.

**Acceptance.** An error toast is announced assertively, can be dismissed, and survives while the
pointer is over it.

---

### UX-21 — Two destructive actions with no confirmation: "Stop all servers" and closing a terminal tab

**Severity: medium · Effort: small · Verified**

**Files:** `client/src/lib/components/AppMenu.svelte:94-96`;
`client/src/lib/components/TopBar.svelte:59`; `client/src/lib/ops.svelte.ts:223-233`;
`client/src/lib/components/dock/TabStrip.svelte:162-166`

Everything else destructive in `ops.svelte.ts` confirms — `closeSession`, `deleteFeature`,
`closeFeature`, `deactivateSession` all go through `uiConfirm`. Two do not:

1. AppMenu's "Stop all servers" fires `runningFeats().forEach((f) => stopStack(f.name))` on a single
   click. Its own comment calls it "Fleet-wide and destructive", and it sits one item below "Restart
   all servers" in the same menu, so a mis-aimed click on a 32px row kills every dev server you have.
2. `closeTab` kills a live tmux window with no confirmation from either the ✕ or a middle-click
   (`onAuxClick`, which fires on button 1 anywhere on the tab). That tab may be running a test
   suite, a build, or a dev server started from a run configuration — and there is no reopen.

**Fix.** AppMenu: `if (await uiConfirm(\`Stop the dev servers for ${runningCount} feature(s)?\`,
{ title:'Stop all servers', okLabel:'Stop all', danger:true })) onstopall?.()` — pass the count down
from TopBar alongside `anyRunning`. `closeTab`: confirm only when the tab is not obviously
disposable — skip the prompt for a tab still titled `shell`, prompt otherwise. Never confirm on the
agent's own tab; instead **disable** close for `t.id === agentTabId`.

**Acceptance.** "Stop all servers" names the count and requires confirmation; closing a named tab
prompts; the agent tab's close control is disabled.

---

### UX-26 — SessionCard ignores the suppress-the-default rule FeatureCard is built on

**Severity: medium · Effort: trivial · Verified**

**Files:** `client/src/lib/components/rail/SessionCard.svelte:46-56`;
`client/src/lib/components/rail/FeatureCard.svelte:78`, `:105`

FeatureCard's central rule — argued at length at FeatureCard:16-27, implemented at :78 (`notable`)
and :105 — is that a state pill appears only for `working`/`waiting`, because `idle` and `stopped`
said nothing and crowded out the one row that mattered. SessionCard, drawn in the same list, does
the opposite: line 51 renders `<span class="pill {session.state}">` unconditionally, so `idle` and
`stopped` pills sit in the rail; and line 55 renders `<span class="src">{session.source}</span>`
unconditionally, printing `freetext` on every locally-created session — the exact string
`DockHead.svelte:27,75` goes out of its way to suppress via `LOCAL_SOURCES`. Unpromoted sessions
are sorted first, so the first cards a user sees are the ones violating the rule.

**Fix.** Add `const notable = $derived(session.state !== 'idle' && session.state !== 'stopped')` and
wrap the pill in `{#if notable}`. Export `LOCAL_SOURCES` from `ui.svelte.ts` (currently private to
`DockHead.svelte:27`) and gate line 55 on `session.source && !LOCAL_SOURCES.has(session.source)`.
Update `SessionCard.test.ts`.

**Acceptance.** An idle, locally-created session card shows neither a state pill nor a source chip.

---

### UX-28 — Selection state is invisible to assistive tech in Intake and the main-server rail card

**Severity: low · Effort: small · Verified**

**Files:** `client/src/lib/components/IntakeModal.svelte:105-114`, `:144-146`;
`client/src/lib/components/rail/MainServerCard.svelte:36-40`;
`client/src/lib/components/rail/Rail.svelte:65-85`;
`client/src/lib/components/rail/SessionCard.svelte:57`

Five small inconsistencies against patterns this codebase already gets right elsewhere:

1. Intake's source chooser is four spans with `use:activatable` — they render as tabs, but there is
   no `role="tablist"`/`role="tab"`/`aria-selected`; the selected one differs by
   `background:var(--elevated)` (1.07:1) plus a text-colour shift. A disabled source is a bare span,
   not focusable and not announced as unavailable.
2. Intake's issue rows are `use:activatable` divs → `role="button"`, with selection expressed only
   as `border-color:var(--brand)` and no `aria-pressed`/`aria-selected`.
3. `MainServerCard`'s `.hit` button has neither `aria-pressed` nor `aria-label`, while its siblings
   `FeatureCard` and `SessionCard` both set `aria-pressed={selected}` and a descriptive label.
4. `.rail-list` is `role="list"` but contains non-listitem children (`.divider`, `.rail-empty`),
   which invalidates the list for AT.
5. `SessionCard` nests an `<a>` inside its `.hit` `<button>` (line 57) — invalid interactive nesting.

**Fix.** (1) `role="tablist" aria-label="Session source"` on `.srctabs`, `role="tab"
aria-selected={…}` on each enabled span, `aria-disabled="true" tabindex="-1"` on disabled ones, and
a 2px `--brand` bottom border on `.srctab.on` so selection is visible without relying on 1.07:1.
(2) `role="listbox"` on `.issuelist`, `role="option" aria-selected={…}` on each `.issue`.
(3) `aria-pressed={selected} aria-label="Select {worktree.repo} main-checkout server"`.
(4) Move the divider and empty state outside the `role="list"`, or drop the list roles entirely.
(5) Move the source link out of `.hit` into the `.meta` row as a sibling of the button.

**Acceptance.** No lint suppressions remain for these five; each selected item announces its state.

---

### UX-29 — `ServerBar.svelte` is dead code, and its header comment documents a layout that no longer exists

**Severity: low · Effort: trivial · Verified**

**Files:** `client/src/lib/components/dock/ServerBar.svelte:1-23`;
`client/src/lib/components/ActionBar.svelte:20-22`; `client/src/lib/components/LinkChip.svelte:6-9`

Nothing imports `ServerBar` — the only two occurrences of the string in the tree are prose
references in `ActionBar.svelte:20` and `LinkChip.svelte:8`. Its comment asserts "it renders INSIDE
the ActionBar, left of the verbs", which was true before the one-bar consolidation and is now false;
`DockHead` renders the repo chips and ports itself. `LinkChip.svelte:7` similarly claims "the dock
header, the ActionBar overflow and anywhere else render this" — LinkChip has exactly one call site.

Two of the most carefully-written design comments in the codebase now describe a UI that is not
there. Since comments are how this project transmits intent, a stale one is worse than none.

**Fix.** Delete `client/src/lib/components/dock/ServerBar.svelte`. Correct `LinkChip.svelte:6-9`
(after **UX-11**, it is rendered by both branches of the identity bar). Trim
`ActionBar.svelte:20-22`'s ServerBar paragraph to past tense or drop it.

**Acceptance.** `grep -r ServerBar client/src` returns nothing.

---

## §5 — Language

### The vocabulary table

One concept per row. The **Use** column is the canonical term; everything in **Currently also
said** is drift to be removed. `MANUAL.md:33-48`'s glossary is the authority where it has an entry,
and it already declares in bold that "**The UI says 'session' everywhere**" — which today it does
not.

| Concept | **Use** | Currently also said | Where the drift is |
|---|---|---|---|
| A live Claude Code process Studio drives | **session** | "agent" | `ActionBar.svelte:173`, `TabStrip.svelte:205`, `FeatureCard.svelte:108` (LANG-04) |
| The set of dev servers belonging to one feature | **dev servers** | "stack", "servers" | `ActionBar.svelte:121/122/124`, `Palette.svelte:72`, `shortcuts.svelte.ts:53` (LANG-02) |
| One or more worktrees sharing a name | **feature** | "group" | `SettingsModal.svelte:320-339` (LANG-06) |
| A feature defined by hand in config | **manual feature** | "feature group", "config.groups" | `SettingsModal.svelte:320`, `FeatureCard.svelte:97`, `FeaturePane.svelte:74` (LANG-06) |
| A change proposed to a forge | **request** (or per-provider PR / MR) | "PR / MR", "Pull / merge requests", "merge requests", "MR" | `ActionBar.svelte:193`, `ops.svelte.ts:563/591/310`, `links.ts:180`, `LinkChip.svelte:30` (LANG-05) |
| Stop the running thing, keep the record | **deactivate** | "close" (features), "deactivate" (sessions) | `ActionBar.svelte:196` vs `:181` (LANG-07) |
| Remove worktrees from disk | **delete** | — (correct, but indistinguishable from "close" on the button) | `ActionBar.svelte:198` (LANG-07) |
| Node packages a worktree needs | **dependencies** ("deps" only in badges) | "deps", "dependencies", "node_modules" | `ActionBar.svelte:132/134`, `FeatureCard.svelte:112`, `start-report.ts:67`, `ops.svelte.ts:660-663` (LANG-11) |
| A concurrency offset a feature holds | **slot** | "concurrency slot" in errors | `servers.ts:358` (LANG-01) |

---

### LANG-01 — Server error strings reach the toast verbatim: lowercase, system-voiced, no remedy

**Severity: high · Effort: medium · Verified**

**Files:** `client/src/lib/api.ts:100`; `client/src/lib/ops.svelte.ts:29`; and roughly seventy
server strings, including `server/orchestrator.ts:176/268/331/341`,
`server/servers.ts:358/642/643/666/781/789/798`, `server/sessions.ts:858/1094/1123`,
`server/worktree.ts:310`, `server/forge.ts:398`, `server/server.ts:935`

`api()` throws `Error(data.error)` (api.ts:100) and every op does `toast(errMessage(e), true)`
(ops.svelte.ts:29), so the raw server string is what a human reads. Those strings were written as
API diagnostics: lowercase, no terminal punctuation, naming internals, and almost none say what to
do next. `"(use force?)"` is addressed to a developer at a git prompt — there is no force control
anywhere in this UI. Contrast `api.ts:97` ("Cannot reach the Worktree Studio daemon.") and
`sessions.ts:809-815` (the gitignore refusal), which prove the codebase knows how.

**The rule to adopt:** sentence case; a period only on complete sentences; problem first, remedy
after an em-dash or in a second sentence; never a bare verb. Write it down as a comment at the top
of `stores/toasts.svelte.ts`, next to the existing timing note.

**The rewrites.** Apply verbatim; each has been checked against the code path that emits it.

| File:line | Current | Rewrite |
|---|---|---|
| `servers.ts:781` | `no start config for repo '${repo}'` | `No start command configured for ${repo}. Add one in Settings → Dev servers.` |
| `servers.ts:358` | `no free concurrency slot (max ${max} running)` | `All ${max} concurrency slots are in use. Stop another feature's dev servers, then try again.` |
| `servers.ts:798` | `port ${p} already in use (pid ${pid})` | `Port ${p} is already in use by process ${pid}. Stop it, or give ${repo} a different port in Settings → Dev servers.` |
| `servers.ts:642` | `no package.json here` | `${basename} has no package.json, so there are no dependencies to install.` |
| `servers.ts:643` | `already installing` | `Dependencies are already being installed here.` |
| `servers.ts:666` | `npm install exited ${code}` | `npm install failed (exit ${code}). Open Logs for the output.` |
| `servers.ts:789` | `another launch for '${repo}' at ${p} is in progress` | `Another launch for ${repo} is already in progress. Wait for it to finish.` |
| `sessions.ts:858` | `already promoted` | `This session already has a worktree.` |
| `sessions.ts:1094` | `invalid title` | `A session needs a name.` (matches `sessions.ts:1020`'s `a tab needs a name` → `A tab needs a name.`) |
| `sessions.ts:1123` | `worktree missing` | `The worktree for this session is no longer on disk.` |
| `worktree.ts:310` | `worktree remove failed (use force?)` | `Could not remove the worktree: ${stderr}` |
| `orchestrator.ts:268`, `server.ts:935` | `no editor configured` | `No editor is configured. Add one in Settings → Editors.` |
| `orchestrator.ts:331` | `feature has no members` | `This feature has no worktrees yet.` |
| `forge.ts:398` | `gh/glab unavailable or failed` | `gh and glab are installed but neither could open a request. Check \`gh auth status\`.` |
| the `no such X` family — `orchestrator.ts:176/215/229/263/285/301`, `server.ts:570/600/647/673/700`, `routes-review.ts:53`, `runner.ts:198/212` | `no such feature` / `no such session` / … | `That ${noun} no longer exists — the view may be out of date. Refresh.` |
| `runner.ts:270` | `still running — stop it first` | `That run is still going. Stop it first.` |
| `IntakeModal.svelte:61` | `out.error \|\| 'failed'` | `Could not load items from ${source}. Check its token in Settings.` |
| `RunsPanel.svelte:100` | `Could not rerun` | `Could not start that run again.` |
| `RunsPanel.svelte:107` | `Could not remove that run` | `Could not remove that run from the history.` |
| `ReviewPanel.svelte:172` | `Stage failed — ${message}` | `Could not ${a.op} that hunk — ${message}` |

Leave the API-contract strings (`routes-review.ts:112/123`, `hunks.ts:141/153`, `review.ts:327`) as
they are — they only fire on a client bug — but stop surfacing them raw: toast a generic
"Something went wrong loading that diff. Refresh and try again."

Pairs with **BUG-19** (five session routes answer `{ok:false}` with no error string at all) — do
them together, since half of these messages do not currently exist.

**Acceptance.** No user-visible string starts with a lowercase letter or names an internal that has
no control in the UI.

---

### LANG-02 — "Stack" is the UI's most prominent noun and it is defined nowhere

**Severity: high · Effort: small · Verified**

**Files:** `client/src/lib/components/ActionBar.svelte:121`, `:122`, `:124`;
`client/src/lib/components/AppMenu.svelte:92`, `:95`; `client/src/lib/components/Palette.svelte:72`;
`client/src/lib/shortcuts.svelte.ts:53`; `client/src/lib/components/SettingsModal.svelte:246`;
`client/src/lib/components/dock/LogsPanel.svelte:120`, `:122`;
`client/src/lib/components/dock/FeaturePane.svelte:88`; `MANUAL.md:33`

The action bar's three primary buttons say "Run stack" / "Stop stack" / "Restart stack". Nothing
else in the product uses the word. The ⋮ menu calls the identical operation applied fleet-wide
"Restart all servers" / "Stop all servers" (AppMenu:92,95 — these literally call
`restartStack`/`stopStack` in a loop, per `TopBar.svelte:58-59`). Settings calls the configuration
"Dev servers". `LogsPanel`'s empty state says "start a dev server". `FeaturePane`'s column is headed
"Servers". `MANUAL.md`'s glossary defines Session, Repo, Worktree, Promote, Feature, Slot, Dev
server, Multiplexer, Dock, Intake — and has **no entry for "stack"**.

The three loudest buttons in the app use a term the user has never been taught, for a thing they
have been taught to call a dev server. "Stop all servers" and "Stop stack" on one screen read as two
different scopes of two different things, when one is a loop over the other.

**Fix.** Use "dev servers". `ActionBar:121` → `Stop servers`, `:122` → `Restart servers`, `:124` →
`Run servers`, each with a `title` naming the scope (the real content "stack" was carrying):
`title="Start the dev servers for all N repos of this feature"`. `Palette:72` → `Run dev servers`.
`shortcuts.svelte.ts:53` → `['⌘R','Run dev servers']`. AppMenu:92/95 already say "servers" — keep,
and they now read as the fleet-wide version of the same verb. Then delete "stack" from
`MANUAL.md` §4 (221-223) and §Feature reference (325), or add a glossary row if it stays as
doc-only shorthand.

**Acceptance.** `grep -ri 'stack' client/src MANUAL.md` returns no user-facing noun.

---

### LANG-03 — A toast tells the user to press a button that does not exist

**Severity: high · Effort: trivial · Verified**

**File:** `client/src/lib/ops.svelte.ts:463-467`

`startFeatureSession` toasts `'Session already open — "Go to session ▸"'` or
`` `Session started for ${f.name} — "Go to session ▸"` ``. The quotation marks and the ▸ glyph
present "Go to session" as the name of a control. `grep -rn "Go to session" client/src` returns
only these two lines — no such button, menu item, palette command or link exists. Worse, the same
function has already called `ui.select(r.session.id)` two lines above (`:461`), so the navigation
being instructed has already happened. The user reads a toast, hunts for a quoted control, does not
find it, and concludes the UI is broken. It fires on the happy path.

**Fix.** Replace both branches with a statement of outcome: `r.existed ? 'That feature already has
a session — showing it now.' : \`Session started for ${f.name}.\``. If a navigation affordance is
genuinely wanted, add an action button to the toast component (`stores/toasts.svelte.ts` currently
supports only `msg` and `err`) rather than naming one in prose.

**Acceptance.** No toast quotes the name of a control that does not exist.

---

### LANG-04 — "Agent" appears in tooltips for the thing the UI calls a session, contradicting the project's own written rule

**Severity: medium · Effort: trivial · Verified**

**Files:** `client/src/lib/components/ActionBar.svelte:173`;
`client/src/lib/components/dock/TabStrip.svelte:205`;
`client/src/lib/components/rail/FeatureCard.svelte:108`; `MANUAL.md:36`

`MANUAL.md:36` states, in bold: "**The UI says 'session' everywhere** — it used to say 'agent' in
some places and 'session' in others for this one thing." It does not. `ActionBar:173` is
`title="Resume — restart the agent and reattach its conversation"` on a button whose `aria-label` on
the next line is "Resume session". `TabStrip:205` is `title="The agent is {session.state}"`.
`FeatureCard:108` titles the state pill "The Claude session driving this feature" — a third
phrasing — while the pill's CSS class is `.pill.agent`. One concept, three nouns, in tooltips a user
hovers within seconds of each other. Tooltips are where a user goes when they do not understand a
control; a different noun each time makes "agent" look like a distinct object with distinct rules.

**Fix.** `ActionBar:173` → `title="Resume — restart the session and reattach its conversation"`.
`TabStrip:205` → `title="This session is {session.state}"`. `FeatureCard:108` →
`title="The Claude Code session driving this feature"`. Leave `.pill.agent` and internal identifiers
alone — this is strings only. `SearchHit.svelte:62`'s "subagent" is correct and stays: that is
Claude's own term for a sidechain, not a Studio object.

**Acceptance.** No user-facing string says "agent" for a Studio session.

---

### LANG-05 — One forge concept, four different renderings

**Severity: medium · Effort: small · Verified**

**Files:** `client/src/lib/components/ActionBar.svelte:193`; `client/src/lib/ops.svelte.ts:563`,
`:591`, `:310`; `server/links.ts:180`; `client/src/lib/components/LinkChip.svelte:30`

Pressing one button walks the user through four spellings: the button says "Create PR / MR"
(ActionBar:193), the toast says "Opening PR / MR…" (ops:563), the result dialog is titled "Pull /
merge requests" (ops:591), the link editor's placeholder says "⑂ no merge requests yet" (ops:310),
the chip on the dock header says "no MR" (links.ts:180), and that chip's tooltip says "${repo} has
no open merge request" (LinkChip:30). "MR" is GitLab's word; `forge.ts` tries `gh` first and
Settings shows GitHub as the always-present integration with GitLab behind a checkbox, so a
GitHub-only user — the default configuration — sees "MR" permanently on their dock header for a
thing GitHub calls a pull request.

**Fix.** Preferred: derive the noun per repo. `server/forge.ts` already tracks which provider
succeeded and `CiRepo` carries the URL — use "pull request" for github.com and "merge request" for
GitLab, and label the chip `no PR` / `no MR` accordingly. Fallback if that is too much:
standardise on "request" — ActionBar:193 → `Create request`, ops:563 → `Opening the request…`,
keeping "Pull / merge requests" only as the multi-repo dialog title. Either way,
`links.ts:180`'s `sub: 'no MR'` and `LinkChip.svelte:30`'s tooltip must agree with the button that
creates it.

**Acceptance.** One noun per provider, used identically on the button, the toast, the dialog title,
the chip and the tooltip.

---

### LANG-06 — Settings says "group" five times for the thing the rest of the app calls a feature

**Severity: medium · Effort: trivial · Verified**

**Files:** `client/src/lib/components/SettingsModal.svelte:320`, `:325-327`, `:334`, `:335`, `:339`;
`client/src/lib/components/rail/FeatureCard.svelte:97`;
`client/src/lib/components/dock/FeaturePane.svelte:74`

The section is headed "Feature groups"; its explanatory note uses "feature" and "group" as two
different things in one sentence; then the controls say "group name…", "Group members", "＋ add
group". Elsewhere the same manual override is surfaced as a badge reading "manual" whose tooltip
says "Grouped by config.groups, not by name" (FeatureCard:97) / "…not by shared name"
(FeaturePane:74) — two wordings of one tooltip. A user who has learned that the unit of work is a
"feature" is asked to name a "group" and list its "members", and must infer that a group *is* a
feature. It is also the only place the config file's key names leak into the interface.

**Fix.** Rename the section to "Manual features", keeping the note verbatim (it is the best copy in
the modal). `:334` placeholder → `feature name…`, aria-label → `Feature name`; `:335` aria-label →
`Worktrees in this feature`; `:339` → `＋ add manual feature`. Make the two badge tooltips
identical, and drop the config key: "Defined by hand in Settings, not by a shared worktree name."
Nothing about the wire format or `config.groups` changes.

**Acceptance.** No user-facing string in Settings says "group" or "config.groups".

---

### LANG-07 — The same reversible-stop concept is "Close" on a feature and "Deactivate" on a session, and "Close" sits next to "Delete"

**Severity: medium · Effort: small · Verified**

**Files:** `client/src/lib/components/ActionBar.svelte:196`, `:198`, `:181`;
`client/src/lib/ops.svelte.ts:604-607`, `:359-362`, `:347-351`

For a feature: "Close feature" (stops servers, deactivates sessions, keeps worktrees) beside
"Delete feature…" (removes worktrees, optionally branches). For a session: "Deactivate" (stops the
process, keeps the session) beside a 🗑 whose tooltip says "Delete session". So the reversible verb
is "Close" in one place and "Deactivate" in the other, for the same idea. Meanwhile "Close" and
"Delete" are near-synonyms in casual use, and the two buttons are adjacent, differing only by an
ellipsis and a red tint. The confirm dialogs do carry the consequence; the buttons do not, and the
ellipsis convention is applied to only one of the three dialogs these buttons open.

**Fix.** Rename "Close feature" (ActionBar:196) to `Deactivate feature`, matching the session verb
and the dialog's own wording; update `ops.svelte.ts:604-607`'s title to `Deactivate feature`,
`okLabel` to `Deactivate`, and the toast at `:610` to `Deactivated ${name}`. Add consequence
tooltips: `:196` → "Stop its dev servers and pause its session. Worktrees and branches are kept.";
`:198` → "Remove its worktrees from disk. Cannot be undone." Apply the ellipsis convention to all
three confirm-opening controls or none.

**Acceptance.** One verb for "stop but keep"; both destructive buttons state their consequence in a
tooltip.

---

### LANG-08 — Desktop notifications identify the work by repo name — the one identifier that is not unique per session

**Severity: medium · Effort: trivial · Verified**

**Files:** `client/src/lib/stores/notify.svelte.ts:90-91`;
`client/src/lib/components/TopBar.svelte:43`

`#fire()` builds `` title = kind === 'waiting' ? `${s.repoName} needs your input` : `${s.repoName} —
turn complete` `` and `body = s.activity || s.title || ''`. `repoName` is the repository, not the
feature or session — and the entire premise of the product is that one repo hosts many concurrent
features. With three features running in `api`, all three notifications read "api needs your input".
The session's own name, shown on the rail card, the dock header and the Waiting button, is demoted
to the body and only appears when `activity` is empty. `TopBar.svelte:43` gets this right ("N
session(s) waiting for you — go to the next").

The notification is the one surface seen when the user is *not* looking at the app, so it is the one
that most needs to say which feature is asking.

**Fix.** `const who = s.title?.trim() || s.repoName;` then `` title = kind === 'waiting' ? `${who}
needs your input` : `${who} — turn complete` ``. Keep `body = s.activity || ''`. Consider appending
the repo when the title differs: `` `${who} · ${s.repoName}` ``.

**Acceptance.** Two waiting sessions in the same repo produce two distinguishable notifications.

---

### LANG-09 — An empty state styled as an error, and one op reports intent where its siblings report outcome

**Severity: low · Effort: small · Verified**

**File:** `client/src/lib/ops.svelte.ts:142`, `:372`, `:538-547`, `:629`

Three violations of the module's own stated conventions:

1. `:142` — `if (!avail.length) return toast('No other repos to add.', true)`. Passing `true` marks
   it an error: red, 6s instead of 3.2s. Nothing failed; the user has one repo. This trains the user
   that red toasts are not worth reading.
2. `:372` — `toast('Resuming session')` announces an intention, which the comment at `:540-541`
   explicitly identifies as the bug it fixed in `restartStack` ("'Restarting …' was fire-and-forget
   optimism"). The same optimism survives in `activateSession`, so a resume that fails to attach
   still shows a reassuring message.
3. `:629` — `toast(r.ok ? \`Deleted ${f.name}\` : 'Some removals failed', !r.ok)`. On a multi-repo
   feature this is the only feedback, and it names neither which repo failed nor why, even though
   the route returns per-repo results (`orchestrator.ts:301-315` pushes `{repo, ok, error}`). See
   **BUG-08**, where that dropped error is the one actionable line in the response.

**Fix.** (1) `toast('No other repos to add — this feature already spans them all.')`, no error flag.
(2) Await the response and report it, matching `restartStack`: `toast('Session resumed')` on
success, letting the catch report failure. (3) Build the message from the per-repo results the way
`startResult()` (`:487-503`) already does: `` `Could not remove ${failed.map(f => f.repo).join(',
')} — ${failed[0].error}` ``.

**Acceptance.** No non-failure uses the error toast; no toast announces an intention.

---

### LANG-10 — FeaturePane has a "Servers" column holding a reason and a "State" column holding the session's state

**Severity: low · Effort: trivial · Verified**

**File:** `client/src/lib/components/dock/FeaturePane.svelte:88`, `:95`, `:97`, `:30-37`

The header row is `Repo | Branch | Servers | Ports | State`. The "Servers" cell renders
`memberWhy(m)`, which returns "running", "deps missing", "no start command for api", or "stopped" —
a mixture of a state and a reason-it-has-no-state. The "State" cell renders `memberState(m)`, which
is the **session's** state (working/waiting/idle), or the server's when there is no session. Two
adjacent columns both describe state, neither header says whose, and one silently switches subject.
"no start command for api" also repeats the repo name that is already the first cell of the same
row, widening a table that already scrolls at `min-width:560px`. This table is the whole
justification for FeaturePane existing.

**Fix.** Headers → `Repo | Branch | Dev server | Ports | Session`. In `memberWhy` (:30-35), drop the
repo: `if (m.noStartCmd) return 'no start command';`. Use the same words the rail card uses for
stopped/running so the two surfaces match. If `memberState` can return a server state when there is
no session, that column cannot be headed "Session" — render `—` instead of borrowing the server's
state, which is the ambiguity itself.

**Acceptance.** No two columns in the table describe state without saying whose.

---

### LANG-11 — Dependencies are called three things across four surfaces, one of which names an implementation detail

**Severity: low · Effort: trivial · Verified**

**Files:** `client/src/lib/components/ActionBar.svelte:132`, `:134`;
`client/src/lib/components/rail/FeatureCard.svelte:112`;
`client/src/lib/components/dock/FeaturePane.svelte:32`; `server/start-report.ts:67`;
`client/src/lib/ops.svelte.ts:660-663`

The button says "Install deps (2)" with a tooltip saying "…cannot start until their dependencies
are installed". The rail pill says "deps missing" with a tooltip saying "N of M worktree(s) have no
**node_modules** — their dev server cannot start until deps are installed". FeaturePane's cell says
"deps missing". The stack-start toast says "dependencies not installed". The install toasts say
"Installing dependencies in api…" then "api is ready", abandoning the noun entirely. This is the
blocked-state the app surfaces most often — every new worktree starts in it — and the word changes
between the pill that reports it, the button that fixes it and the toast that confirms the fix.
"node_modules" is the only place a user is told about the mechanism rather than the state, and it
will be wrong the moment a non-npm repo is supported (see **BUG-09**).

**Fix.** "dependencies" in every full sentence; "deps" only where width forces it (rail pill, table
cell). `ActionBar:134` → `Install dependencies (${n})`. `FeatureCard:112` tooltip → `${noDeps} of
${ms.length} worktree(s) have no dependencies installed, so their dev server cannot start. Use
Install dependencies in the action bar.` (drop node_modules). `ops.svelte.ts:663` → `Dependencies
installed in ${w.repo}`; `r.error || 'install failed'` → `r.error || 'Could not install
dependencies. Open Logs for the output.'`

**Acceptance.** No user-facing string says "node_modules"; full sentences say "dependencies".

---

### LANG-12 — No single style rule for messages, so hand-written and machine-written copy share one toast slot

**Severity: low · Effort: small · Verified**

**Files:** `client/src/lib/api.ts:97`; `client/src/lib/components/dock/RunsPanel.svelte:100`, `:107`;
`client/src/lib/components/IntakeModal.svelte:61`;
`client/src/lib/components/review/ReviewPanel.svelte:172`; `client/src/lib/ops.svelte.ts:366`;
`server/start-report.ts:134`; `server/runner.ts:270`

Four registers appear in the same bottom-right region: full sentences with a period ("Cannot reach
the Worktree Studio daemon."); sentence-case fragments with no period ("Could not rerun",
"Deactivated"); lowercase server fragments (the whole LANG-01 family); and the literal word
`'failed'` as a fallback (`IntakeModal.svelte:61`). `ReviewPanel:172` uses an em-dash convention of
its own that appears nowhere else. Toasts get about a second of attention before they expire; a
region that alternates between "failed" and a full polite sentence reads as unfinished and makes the
good messages look accidental.

**Fix.** Write the rule down at the top of `stores/toasts.svelte.ts` (see LANG-01) and fix the
outliers listed in LANG-01's rewrite table. This is the smallest item here, and it is what makes
LANG-01 and LANG-03 stay fixed.

**Acceptance.** A written convention exists in the source, and no message violates it.
