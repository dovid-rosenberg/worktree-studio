// Handing a path — or a whole feature's worth of paths — to the user's editor.
//
// A module rather than a lambda in the composition root because the interesting part
// is not the route, it is the templating: `openGroup` in one command versus a loop over
// `open` is the difference between one Zed workspace and four WebStorm windows, and
// getting it wrong is a mess on the user's screen rather than a 500 in a log.
//
// `api` is the ONE router server.ts mounts at both /api and /api/v1 — see
// server/routes-review.ts for why registering onto it is what makes the two prefixes
// answer identically.
import type { Router } from 'express';
import { openEditor, resolveEditor, shq } from './util.ts';
import type { EditorLike } from './util.ts';

/** Typed by the two config keys this route reads, not by the whole Config. */
interface OpenDeps {
  cfg: {
    editors?: Record<string, EditorLike>;
    defaultEditor?: string;
  };
}

function register(api: Router, { cfg }: OpenDeps): void {
  /*
   * Takes `path` (one) or `paths` (many). A feature spans several repos, so a session
   * driving it has several worktrees to look at, and this route could only ever open
   * one — the caller's only option was to open the primary and go find the rest by hand.
   *
   * `paths` uses the editor's `openGroup` template when it has one (Zed takes every path
   * as a single workspace) and otherwise loops `open`, which is exactly what
   * /group/open does — WebStorm has no openGroup, so it gets one window per repo.
   */
  api.post('/open', async (req, res) => {
    const { path: p, paths, editor } = req.body || {};
    // Splits "did not name one" from "named one that does not exist" — the old
    // `editors[x] || editors[default]` silently opened the default for a typo.
    const pick = resolveEditor(cfg.editors, editor, cfg.defaultEditor || '');
    if (!pick.ok) return res.status(400).json({ ok: false, error: pick.error });
    const ed = pick.editor;
    // Dedupe: two repos of one feature are distinct worktrees, but a caller that passed
    // the same path twice must not open two windows on it.
    const list = [
      ...new Set(
        (Array.isArray(paths) ? paths : [p]).filter((x): x is string => typeof x === 'string' && !!x),
      ),
    ];
    if (!list.length) return res.status(400).json({ error: 'path or paths is required' });
    // split/join, not replace(): `$&`/`` $` ``/`$'`/`$$` in a REPLACEMENT string expand
    // after shq() quoted the path, so such a path would open the wrong file.
    const cmds =
      list.length > 1 && ed.openGroup
        ? [ed.openGroup.split('{paths}').join(list.map(shq).join(' '))]
        : list.map((one) => ed.open.split('{path}').join(shq(one)));
    // The exit code, not a hardcoded ok — see openEditor().
    const opened = await openEditor(cmds);
    if (!opened.ok) return res.status(500).json({ ok: false, error: `editor failed: ${opened.error}` });
    res.json({ ok: true, opened: list.length });
  });
}

export { register };
