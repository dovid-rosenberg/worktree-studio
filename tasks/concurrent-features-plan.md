# Running 2–3 features concurrently — feasibility + plan

**Status: PLAN ONLY (not implemented).** Branch `feature/concurrent-features`, cut off the
(unmerged) `feature/cockpit-upgrades` HEAD per instruction.

**Goal:** run 2–3 full dev stacks (each = accept-blue backend + merchant-v3 frontend) at the same
time on one machine. **Accepted constraint: the MySQL `local` DB stays shared** (no DB isolation).

## Verdict: highly feasible, and cheap — no backend code changes required

The audit of accept-blue's config layer says the app is nearly multi-instance-safe already, for two
reasons:

1. **Everything is env-overridable today.** `config/index.js:14` runs `Nconf.env({separator:'__'}).argv()`
   *before* registering defaults, and nconf's first-registered-wins means **any** config key can be set
   by an env var using `__` for nesting (`api__port_merchant=1339`, `redis__db=1`). So re-porting an
   instance needs **zero code changes** — just env vars at launch.
2. **The job scheduler does not run in dev `fe` mode.** Scheduling lives only in the separate
   `mode=job_schedule` launcher (`app.js` switch → `launchers/job_schedule`). A grep found no
   `scheduleJob`/`setInterval`/`cron` anywhere in request paths or `fe` boot. So **N stacks in `fe`
   mode run zero schedulers → no double settlement/billing, by construction.** The only hard rule is
   operational: **never run more than one `mode=job_schedule` process** (and none of these dev features do).

That removes the two things I was most worried about (per-instance code changes, and double-firing jobs).

## What actually collides (from the audit) and how each isolates

| Resource | Collides? | Isolate via — exists today? |
|---|---|---|
| **5 BE ports** su/iso/merchant/api/internal (`launchers/fe/index.js:37-58`, all read from `Config`) | Yes | env `api__port_su/iso/merchant/internal` + `PORT` (or `api__port`). **No code change.** |
| **Job scheduler** | **No** in `fe` mode | nothing — just never launch >1 `job_schedule`. |
| **Redis** — remote shared host, logical DB 0, unnamespaced keys (`components/cache/index.js`, dev-config `redis` block). Only cache + nonce/idempotency locks + rate limiters; no sessions (JWT), no pub/sub. | Yes | env `redis__db=<n>` per instance (host has 16 DBs). **No code change.** (A key-prefix would need new code; DB index is enough.) |
| **FE dev port** hardcoded `3030` (`merchant-v3/vite.config.js`) | Yes | `npm run dev -- --port 313x` (CLI flag; no env today). |
| **FE→BE base URL** hardcoded `http://localhost:1239/...` in `merchant-v3/src/config.js` (`baseURL`, `paayLibrary.verifyUrl`) | Yes | today: hand-edit those 2 lines; recommended: add a `VITE_API_URL` env read (~3 lines). |
| Self/callback URLs | No | all point at *frontends* (`client_url` etc.), overridable; no BE self-URL with a port is built anywhere. |
| Log/PID files | No | console/DB/cloud transports only; no local log or PID/lock files. |
| Multer temp dirs / cloud bucket / SFTP | Low / data-only | shared paths but random filenames; bucket+SFTP shared (a data concern, not machine-local — same as the shared DB you accepted). |

**Net:** to run a second stack you need to shift **5 BE ports + 1 FE port + 1 redis DB index**, and point
the FE at the shifted merchant port. All of it is env/CLI except the FE base URL (2 hardcoded lines).

## Design: slot-offset + env injection, orchestrated by Worktree Studio

Studio is the right driver — it already owns both repos of a feature and launches their servers via
`start.<repo>`. Add a **slot** concept (0, 1, 2 …; max ~3 configurable):

- **Slot 0** = today's defaults (su 1231, iso 1232, api 1233, merchant 1239, internal 1999, FE 3030, redis DB 0).
- **Slot n** = every port + `n·100`, redis DB = `n`, FE port = `3030 + n·100`:
  - slot 1 → su 1331, iso 1332, api 1333, merchant 1339, internal 2099, FE 3130, redis DB 1
  - slot 2 → su 1431, iso 1432, api 1433, merchant 1439, internal 2199, FE 3230, redis DB 2

On "Run stack" for a feature, Studio: assigns the first free slot → derives the env block → injects it into
each repo's launch command:
- accept-blue: `api__port_su`, `api__port_iso`, `api__port`, `api__port_merchant`, `api__port_internal`, `redis__db`.
- merchant-v3: `--port 313x` and the BE URL (`VITE_API_URL=http://localhost:1339/merchant`, or a templated `src/config.js`).

Studio already detects "running" by **lsof→cwd→worktree** (cockpit P1), *not* by fixed port — so running
detection, the Fleet grouping, and the clickable port chips (cockpit P7) keep working on the shifted ports
with no extra logic. The slot just needs surfacing (a badge + the real ports in the chip).

The scheme is **data-driven in Studio config** (base ports, offset step, max slots, the port→env-key map),
so it isn't hardcoded to accept-blue/merchant-v3 and other repos can opt in.

## The Docker question (you asked: overkill? would it solve everything?)

Docker Compose-per-feature **would** solve everything — including per-feature DB and redis isolation and
network namespacing. But you said the **shared DB is fine**, and the audit shows redis isolates with one
env var and jobs don't run — so Docker would be **solving problems you don't have**, at real cost:
containerizing accept-blue's 5-server boot + merchant-v3, slower rebuild/iteration, and a workflow change.
**Recommendation: skip Docker for this.** Native process + env injection is strictly lighter and sufficient
for 2–3 features. Revisit containers only if you later want true DB-per-feature isolation or prod-parity —
at which point it solves the drift problem too, but that's a different, bigger project.

## Change list (when we build it)

- **accept-blue: none.** Pure env at launch. (Optionally: document the `api__port_*` / `redis__db` keys.)
- **merchant-v3: small (recommended) or none.**
  - Recommended (~3 lines): `src/config.js` reads `baseURL`/`verifyUrl` from `import.meta.env.VITE_API_URL`
    (fallback to today's value), and the vite port from `--port`. Then it's pure env.
  - Or zero-change: Studio templates `src/config.js` per slot when it creates/refreshes the FE worktree
    (it already copies gitignored config files into worktrees).
- **worktree-studio: the actual work (small, self-contained):**
  1. `concurrency` config block (base ports, offset step `100`, `maxSlots` ~3, per-repo env-key map).
  2. Pure `deriveSlotEnv(repo, slot)` → `{ env, ports }` (unit-tested — this is the load-bearing logic).
  3. Slot allocator: assign a free slot per feature on stack-start, release on stack-stop; persist in state.
  4. Thread the derived env into the spawn (`servers.start` / the group-start path currently pass a fixed
     ENV — merge per-feature env on top).
  5. Fleet UI: show each running feature's slot + its real ports (chips already open `localhost:<port>`).

## Phased execution (for later — do NOT run now)

- **A.** Studio `concurrency` config + `deriveSlotEnv` pure fn + tests. (No behavior change yet.)
- **B.** Slot allocator + inject env into start/group-start; release on stop.
- **C.** FE wiring: `VITE_API_URL` + `--port` in merchant-v3 (or Studio-templated `config.js`).
- **D.** Fleet UI (slot badge + real ports) + live verification: two features up at once — distinct BE ports,
  FE ports, redis DBs; confirm lsof detection still groups each correctly and the port chips open the right apps.
- **E.** Docs + the one operational rule (**never >1 `mode=job_schedule`**).

## Risks / notes

- **Shared DB (accepted):** all features see the same data; a schema change in one feature's worktree affects
  all — this is the existing migration-drift issue ([[project_local_db_migration_drift]]), unchanged by this work.
- **The one rule:** never run a second `mode=job_schedule` process (there's no lock/leader-election around the
  scheduler — isolation is purely by process mode). The concurrent dev features are all `fe` mode, so safe.
- **Redis:** with `redis__db=<slot>` each instance gets its own keyspace; without it, nonce locks and
  rate-limit counters pool across instances (mostly harmless given the shared DB, but cleaner to separate).
- Shared cloud bucket (`accept-blue-dev`) + SFTP are shared (data-level, like the DB) — out of scope.
- Ports must be free at launch; Studio's `servers.start` already checks configured ports before spawning.
