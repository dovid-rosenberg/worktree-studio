// Everything that writes config.json, and the two reads the Settings pane opens with.
//
// It lives together because the danger is shared: config.json is one file, POST
// /settings is a FULL REPLACE for every map it carries, and the last single value
// written through it deleted two repos' start commands on the way past. That is why the
// narrow writes below — a feature's colour, a feature's links, one group — are their own
// routes rather than fields on /settings: a one-key write does one-key work, no coercion
// runs, and nothing the body did not mention can be dropped.
//
// The coercion itself is server/settings.ts's; this module decides only WHICH fields a
// request is allowed to touch. Persisting is injected (`saveConfig`) rather than imported
// so the composition root stays the only thing that knows where the file is.
//
// `api` is the ONE router server.ts mounts at both /api and /api/v1 — see
// server/routes-review.ts for why registering onto it is what makes the two prefixes
// answer identically.
import fs from 'fs';
import type { Router } from 'express';
import { browse } from './browse.ts';
import {
  coerceEditors,
  coerceGroups,
  coerceRunConfigs,
  coerceStart,
  isFollowable,
  isRecord,
  upsertGroup,
} from './settings.ts';
import * as sources from './sources/index.ts';
import { expandTilde, has, qs, run } from './util.ts';
import { FEATURE_COLORS } from './types.ts';
import type { Config } from './types.ts';

/** The POST /settings body. Every field is `unknown` until it has been checked. */
interface SettingsBody {
  sources?: unknown;
  runConfigs?: unknown;
  baseDirs?: unknown;
  notify?: unknown;
  start?: unknown;
  editors?: unknown;
  defaultEditor?: unknown;
  groups?: unknown;
  concurrency?: unknown;
}

interface SettingsDeps {
  /**
   * The live config object, MUTATED in place. A whole `Config` rather than a narrow
   * slice: every collaborator in the process holds this same object, so a route that
   * took a copy would save the user's change and leave the running daemon on the old
   * value.
   */
  cfg: Config;
  /** Persist cfg. Injected so this module never learns where config.json is. */
  saveConfig: () => void;
  /** Re-scan the repos. Awaited when a save changed what there is to scan. */
  rescan: () => Promise<unknown>;
  broadcastTopology: () => void;
}

function register(api: Router, deps: SettingsDeps): void {
  const { cfg, saveConfig, rescan, broadcastTopology } = deps;

  api.get('/settings', async (_req, res) => {
    const gh = await run('gh', ['auth', 'status'], {});
    res.json({
      sources: cfg.sources || {},
      baseDirs: cfg.baseDirs || [],
      notify: cfg.notify || {},
      start: cfg.start || {},
      editors: cfg.editors || {},
      defaultEditor: cfg.defaultEditor || '',
      groups: cfg.groups || [],
      // The MANUAL run configurations only; an editor's own are discovered per worktree.
      runConfigs: cfg.runConfigs || {},
      // Only the two knobs the form edits. `repos` is a port map nobody should be able
      // to rewrite through a settings round-trip.
      concurrency: {
        maxSlots: cfg.concurrency?.maxSlots ?? 1,
        slotPolicy: cfg.concurrency?.slotPolicy ?? 'free-ports',
      },
      enabled: sources.enabled(cfg),
      tools: { gh: has('gh'), glab: has('glab') },
      githubAuthed: gh.code === 0,
    });
  });

  /*
   * A feature's colour tag. Its OWN route, deliberately not a field on POST /settings —
   * see the note at the top of this file for what a full replace cost once. An empty
   * colour clears the tag rather than storing a blank, so the map only ever holds live
   * entries.
   */
  api.post('/features/:name/color', async (req, res) => {
    const name = String(req.params.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'no feature named' });
    const color = String(req.body?.color || '').trim();
    if (color && !(FEATURE_COLORS as readonly string[]).includes(color)) {
      return res.status(400).json({ ok: false, error: `unknown colour: ${color}` });
    }
    cfg.featureColors = { ...(cfg.featureColors || {}) };
    if (color) cfg.featureColors[name] = color;
    else delete cfg.featureColors[name];
    saveConfig();
    broadcastTopology();
    res.json({ ok: true, color });
  });

  /*
   * A feature's links: its tracker URL and anything pinned by hand.
   *
   * Keyed by FEATURE, deliberately, not by session: a ticket outlives the agent working
   * on it, and `session.sourceUrl` died whenever the session did.
   */
  api.post('/features/:name/links', async (req, res) => {
    const name = String(req.params.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'no feature named' });
    const body = req.body || {};

    const ticket = typeof body.ticket === 'string' ? body.ticket.trim() : undefined;
    // Every pin needs a url; a label is optional and falls back to the provider's name.
    // Anything without a url is dropped rather than stored as a link to nowhere.
    //
    // ...and the url has to be one a browser may safely follow. These are rendered into
    // an href in a page that holds the boot token, so a stored `javascript:` pin is one
    // click away from reading it out. The client refuses to render an unsafe scheme; this
    // is the half that stops it being written down in the first place, because config.json
    // outlives any particular client and is also hand-edited.
    const pins = Array.isArray(body.pins)
      ? body.pins
          .filter(isRecord)
          .map((x: Record<string, unknown>) => ({
            label: String(x.label || '').trim(),
            url: String(x.url || '').trim(),
          }))
          .filter((x: { url: string }) => !!x.url && isFollowable(x.url))
          .map((x: { label: string; url: string }) => (x.label ? x : { url: x.url }))
      : undefined;

    const next = { ...((cfg.featureLinks || {})[name] || {}) };
    if (ticket !== undefined) {
      if (ticket) next.ticket = ticket;
      else delete next.ticket;
    }
    if (pins !== undefined) {
      if (pins.length) next.pins = pins;
      else delete next.pins;
    }

    cfg.featureLinks = { ...(cfg.featureLinks || {}) };
    // An entry with nothing left in it is removed, so the map only holds live values.
    if (Object.keys(next).length) cfg.featureLinks[name] = next;
    else delete cfg.featureLinks[name];

    saveConfig();
    broadcastTopology();
    res.json({ ok: true, links: next });
  });

  api.post('/settings', async (req, res) => {
    // Every field is `unknown`: a JSON body can carry anything, so nothing here is a
    // string, an object or an array until it has been checked — the same rule
    // server/orchestrator.ts's GroupBody follows.
    const body: SettingsBody = req.body || {};
    const {
      sources: srcs,
      baseDirs,
      notify,
      start,
      editors,
      defaultEditor,
      groups,
      runConfigs: runCfgs,
      concurrency,
    } = body;
    /*
     * A MERGE of two known keys, not a replace.
     *
     * `concurrency.repos` is the port map that makes slots work at all, and it is not on
     * this form. Assigning the posted object wholesale would drop it — the same way a
     * one-key write through this route once deleted two repos' start commands.
     */
    if (isRecord(concurrency)) {
      const max = Number(concurrency.maxSlots);
      const policy = concurrency.slotPolicy;
      cfg.concurrency = cfg.concurrency || { enabled: true, offsetStep: 100, maxSlots: 1, repos: {} };
      if (Number.isInteger(max) && max >= 1 && max <= 16) cfg.concurrency.maxSlots = max;
      if (policy === 'free-ports' || policy === 'lowest') cfg.concurrency.slotPolicy = policy;
    }
    if (isRecord(srcs)) {
      cfg.sources = cfg.sources || {};
      for (const k of Object.keys(srcs)) {
        const prev = cfg.sources[k];
        cfg.sources[k] = { ...(isRecord(prev) ? prev : {}), ...(isRecord(srcs[k]) ? srcs[k] : {}) };
      }
    }
    if (isRecord(notify)) {
      cfg.notify = { ...(cfg.notify || {}), ...notify };
    }
    let rescanNeeded = false;
    let missingDirs: string[] = [];
    if (Array.isArray(baseDirs)) {
      cfg.baseDirs = baseDirs.map((s) => expandTilde(String(s).trim())).filter(Boolean);
      /*
       * A directory that does not exist is REPORTED, not silently accepted.
       *
       * The save answered ok:true and echoed the new dirs back, the scan then found
       * nothing there, and the dashboard emptied — with the three facts connected
       * nowhere. A typo in a path is the single most likely thing to go wrong in this
       * form, and it looked exactly like a successful save.
       *
       * Saved anyway rather than rejected: the directory may be on a volume that is not
       * mounted right now, and refusing the whole save over one row would be worse.
       */
      missingDirs = cfg.baseDirs.filter((d) => !fs.existsSync(d));
      rescanNeeded = true;
    }
    // Dev-server launch config { "<repo>": { cmd, ports:[…] } } — full replace, drop blank rows.
    if (isRecord(start)) {
      cfg.start = coerceStart(start);
      rescanNeeded = true;
    }
    /*
     * Hand-written run configurations, `{ "<repo>": [{ name, cmd, kind }] }` — full
     * replace, blank rows dropped, exactly as `start` and `editors` are handled.
     *
     * These are the MANUAL half only. Whatever an editor declares in a worktree is
     * discovered live (server/run-configs.ts) and is not stored here, so saving this
     * cannot delete a config that came from a file.
     */
    if (isRecord(runCfgs)) cfg.runConfigs = coerceRunConfigs(runCfgs);
    // Editors { "<name>": { open, openGroup? } } — full replace, drop blank rows.
    if (isRecord(editors)) cfg.editors = coerceEditors(editors);
    if (typeof defaultEditor === 'string' && defaultEditor.trim()) cfg.defaultEditor = defaultEditor.trim();
    // Manual feature groups [{ name, members:[…] }] — full replace, drop blank rows.
    if (Array.isArray(groups)) cfg.groups = coerceGroups(groups);
    saveConfig();
    if (rescanNeeded) await rescan();
    else broadcastTopology();
    res.json({
      ok: true,
      // Present only when something is wrong, so the quiet path stays quiet.
      ...(missingDirs.length ? { warnings: [`these folders do not exist: ${missingDirs.join(', ')}`] } : {}),
      sources: cfg.sources,
      baseDirs: cfg.baseDirs,
      runConfigs: cfg.runConfigs,
      notify: cfg.notify,
      start: cfg.start,
      editors: cfg.editors,
      defaultEditor: cfg.defaultEditor,
      concurrency: cfg.concurrency,
      groups: cfg.groups,
      enabled: sources.enabled(cfg),
    });
  });

  /*
   * Group worktrees that ended up under different names.
   *
   * `splitFeatures` on the topology payload reports features that look like one piece of
   * work under two names (see features.ts detectSplitFeatures). This is the half that acts
   * on it, and it is a SINGLE-GROUP write on purpose: the user is answering one question
   * about one card, and POST /settings — a full replace of the whole map — would let a
   * payload built from that card delete every group they had made by hand.
   *
   * The groups live in Studio's own config.json. They are SEEDED from worktree-dash's
   * file on first run and never read from it again, so writing here is Studio editing
   * its own state, not reaching into another tool's.
   */
  api.post('/groups', async (req, res) => {
    const body = isRecord(req.body) ? req.body : {};
    const name = String(body.name || '').trim();
    const members = Array.isArray(body.members)
      ? body.members.map((m) => String(m).trim()).filter(Boolean)
      : [];
    // Two members is what a group MEANS — one worktree is a feature on its own and
    // already groups itself. Saying so beats writing a row that changes nothing.
    if (!name || members.length < 2) {
      return res.status(400).json({ ok: false, error: 'name and at least two members are required' });
    }
    cfg.groups = upsertGroup(cfg.groups, { name, members });
    saveConfig();
    // The grouping changes the topology (two features become one), so the payload has to
    // be rebuilt rather than merely re-sent.
    broadcastTopology();
    res.json({ ok: true, groups: cfg.groups });
  });

  /*
   * Directory listing for the base-directory picker (server/browse.ts).
   *
   * Read-only and shape-only: directory names and whether each is a git checkout. The
   * daemon is the thing that will scan the folder, so the daemon is the thing that can
   * say what folders there are — a browser cannot hand back a path.
   */
  api.get('/fs/dirs', (req, res) => res.json(browse(qs(req.query.path))));
}

export { register };
