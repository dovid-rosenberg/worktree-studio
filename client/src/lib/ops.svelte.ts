/*
 * Every mutating call the shell can make, in one module.
 *
 * These are the action functions from app.js, unchanged in behaviour: same endpoints,
 * same confirmations, same toast wording. They live outside the components because the
 * command palette, the rail, the dock and Fleet all invoke the same handful of them,
 * and duplicating "confirm then POST then toast" per call site is how the two copies
 * drift apart.
 *
 * Convention: an op never throws. It reports through `toast(msg, true)` and returns.
 * The UI's job is to reflect the stream that follows, not the response.
 */

import { api } from '$lib/api.js';
import { toast } from '$lib/stores/toasts.svelte.js';
import type { Feature, Session } from '../../../server/types';
import { uiConfirm, uiDialog, uiPrompt } from '$lib/stores/dialog.svelte.js';
import { world } from '$lib/stores/world.svelte.js';
import { liveMembers, ui } from '$lib/stores/ui.svelte.js';

/**
 * `catch (e)` binds `unknown` under strict mode, and every handler below reports
 * `e.message`. One helper rather than a cast per site — a cast would claim the thrown
 * value is an Error, which nothing guarantees.
 */
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ---------------- sessions ---------------- */

export async function promote(s: Session) {
  const branch = await uiPrompt('Branch to create for this worktree:', s.suggestedBranch || 'feature/x');
  if (!branch) return;
  try {
    let r = await api('POST', `/api/sessions/${s.id}/promote`, { branch });
    /*
     * A promote can strand work two ways, and both are questions rather than failures.
     *
     * Uncommitted edits: you start editing in the main checkout, realise it is real
     * work, and promote. The edits ARE the work. Bringing them stashes with
     * --include-untracked and pops in the new worktree; a conflict leaves the stash
     * intact and says so, so the worst case names where the work is, never loses it.
     *
     * Commits: the new worktree is cut from the pushed base, so commits already made in
     * the main checkout are not in it either. That half used to be silent — no dialog
     * at all. Bringing them cuts the branch from HEAD instead, which COPIES them; they
     * stay on the original branch too, which the dialog says out loud so nobody assumes
     * their branch was rewound.
     */
    if (r.needsConfirm) {
      const dirty = (r.dirty || []).length;
      const ahead = r.ahead || { commits: [], branch: '', base: '' };
      const commits: string[] = ahead.commits || [];

      const fields = [];
      const lines: string[] = [];
      if (dirty) {
        lines.push(`${dirty} uncommitted change(s)`);
        fields.push({ type: 'checkbox' as const, label: 'Bring the uncommitted changes', value: true });
      }
      if (commits.length) {
        lines.push(`${commits.length} commit(s) on ${ahead.branch} that ${ahead.base} does not have`);
        fields.push({
          type: 'checkbox' as const,
          // Said plainly: this copies. The commits remain on the branch you are on.
          label: `Bring the commits (copied — they stay on ${ahead.branch} too)`,
          value: true,
        });
      }
      // Newest first, and only a few: the list is for recognising the work, not reading it.
      const preview = commits.slice(0, 5).map((c) => `  ${c}`).join('\n');

      const choice = await uiDialog({
        title: 'Work that would stay in main',
        message: `The new worktree branches off ${ahead.base || 'the default branch'}, so `
          + `${lines.join(' and ')} would stay behind.`
          + (preview ? `\n\n${preview}${commits.length > 5 ? `\n  …and ${commits.length - 5} more` : ''}` : ''),
        fields,
        okLabel: 'Promote',
      });
      if (!choice || !Array.isArray(choice)) return;

      // Field order follows the order they were pushed above, so read them back the same way.
      let i = 0;
      const bringChanges = dirty ? choice[i++] === true : false;
      const bringCommits = commits.length ? choice[i++] === true : false;
      r = await api('POST', `/api/sessions/${s.id}/promote`, {
        branch,
        // `confirm` is what says "I have seen this and want neither" — without it the
        // server would just ask again.
        ...(bringChanges || bringCommits ? { bringChanges, bringCommits } : { confirm: true }),
      });
    }
    /*
     * The feature may already own worktrees in other repos — made with `wt`, outside
     * Studio, so the session never learned about them. Left alone this is invisible
     * until Changes renders an empty diff (it is session-scoped) or the agent finds it
     * cannot write to a repo it was started for. Offer, rather than attach silently:
     * each attach sends /add-dir into a live session.
     */
    const attachable: { repo: string; worktreePath: string }[] = r.attachable || [];
    if (attachable.length) {
      const names = attachable.map((a) => a.repo);
      const ok = await uiConfirm(
        `This feature already has worktrees in ${names.join(', ')}, but the session cannot see `
        + `them — Changes would show nothing for those repos and the agent could not edit them. `
        + `Attach ${names.length === 1 ? 'it' : 'them'}?`,
        { title: 'Other repos in this feature', okLabel: 'Attach' },
      );
      if (ok) {
        for (const a of attachable) {
          // Serially: each grants /add-dir to the same live session.
          try { await api('POST', `/api/sessions/${s.id}/add-repo`, { repo: a.repo }); }
          catch (e) { toast(`${a.repo}: ${errMessage(e)}`, true); }
        }
      }
    }

    const w = r.worktree || {};
    const warn = (w.warnings || []).find((x: string) => /taken/.test(x));
    // Say what came along; silence would leave the user to go and check.
    const carried = [
      r.brought ? `${r.brought} change(s)` : '',
      r.broughtCommits ? `${r.broughtCommits} commit(s)` : '',
    ].filter(Boolean).join(' and ');
    if (warn) toast(`Promoted as “${w.name}” — ${warn}`);
    else toast(`Promoted → ${w.branch || branch}${carried ? `, brought ${carried}` : ''}`);
  } catch (e) { toast(errMessage(e), true); }
}

export async function addRepoToSession(s: Session) {
  const have = new Set((s.repos || []).map((r) => r.repo));
  const avail = world.repos.map((r) => r.name).filter((n) => !have.has(n));
  if (!avail.length) return toast('No other repos to add.', true);
  const r0 = await uiDialog({
    title: 'Add a repo to this feature',
    message: 'Creates a same-named worktree there and gives the session access.',
    fields: [{ type: 'select', label: 'Repo', value: avail[0], options: avail }],
    okLabel: 'Add',
  });
  // `true` means the dialog had no fields, which this one does — so a non-array here
  // is a caller/spec mismatch, not a pick.
  if (!Array.isArray(r0)) return;
  const pick = String(r0[0] ?? '');
  if (!avail.includes(pick)) return;
  try {
    const r = await api('POST', `/api/sessions/${s.id}/add-repo`, { repo: pick });
    toast(r.already ? `${pick} already in feature` : `Added ${pick} → ${r.worktree.name}`);
  } catch (e) { toast(errMessage(e), true); }
}

/*
 * Tabs are addressed by the multiplexer's window id, never by position: tmux runs with
 * `renumber-windows on`, so closing one window renumbers the rest and any index held
 * across that close names a different window.
 */

/**
 * Opening a shell should not cost a modal. It lands as "shell" and the strip renames
 * in place (double-click / F2), which is how every terminal does it.
 */
export async function addTab(s: Session, title = 'shell') {
  try {
    await api('POST', `/api/sessions/${s.id}/tabs`, { title });
  } catch (e) { toast(errMessage(e), true); }
}

export async function selectTab(s: Session, tab: string) {
  ui.dockView = 'term';
  ui.activeTabId = tab;
  try { await api('POST', `/api/sessions/${s.id}/select-tab`, { tab }); }
  catch (e) { toast(errMessage(e), true); }
}

export async function renameTab(s: Session, tab: string, title: string) {
  try { await api('POST', `/api/sessions/${s.id}/rename-tab`, { tab, title }); }
  catch (e) { toast(errMessage(e), true); }
}

/**
 * Closing the ACTIVE tab has to move the selection, or the strip highlights nothing
 * while a pane is still on screen. Pick the neighbour the way editors do: the one to
 * the right, falling back to the left when the last tab goes.
 */
export async function closeTab(s: Session, tab: string) {
  const tabs = s.tabs || [];
  const i = tabs.findIndex((t) => t.id === tab);
  const next = i >= 0 ? (tabs[i + 1] || tabs[i - 1]) : null;
  try {
    await api('POST', `/api/sessions/${s.id}/close-tab`, { tab });
    if (ui.activeTabId === tab && next) await selectTab(s, next.id);
  } catch (e) { toast(errMessage(e), true); }
}

export async function closeSession(s: Session) {
  const ok = await uiConfirm(`Delete “${s.title}”? This kills its ${world.mux} session and removes it.`, {
    title: 'Delete session', okLabel: 'Delete', danger: true,
  });
  if (!ok) return;
  try {
    await api('DELETE', `/api/sessions/${s.id}`);
    if (ui.selectedId === s.id) ui.selectedId = null;
    toast('Session deleted');
  } catch (e) { toast(errMessage(e), true); }
}

export async function renameSession(s: Session) {
  const title = await uiPrompt('Rename session:', s.title);
  if (title === null || !title.trim()) return;
  try { await api('POST', `/api/sessions/${s.id}/rename`, { title }); toast('Renamed'); }
  catch (e) { toast(errMessage(e), true); }
}

export async function deactivateSession(s: Session) {
  const ok = await uiConfirm(
    `Deactivate “${s.title}”? Stops the process; you can resume it later to continue the conversation.`,
    { title: 'Deactivate', okLabel: 'Deactivate' },
  );
  if (!ok) return;
  try { await api('POST', `/api/sessions/${s.id}/deactivate`, {}); toast('Deactivated'); }
  catch (e) { toast(errMessage(e), true); }
}

export async function activateSession(s: Session) {
  try { await api('POST', `/api/sessions/${s.id}/activate`, {}); toast('Resuming session'); }
  catch (e) { toast(errMessage(e), true); }
}

/* ---------------- dev servers ---------------- */

export async function startSessionServers(s: Session) {
  try {
    const r = await api('POST', `/api/sessions/${s.id}/servers/start`, {});
    toast(r.ok ? 'Workspace servers starting' : 'Some failed to start', !r.ok);
  } catch (e) { toast(errMessage(e), true); }
}

export async function stopSessionServers(s: Session) {
  try { await api('POST', `/api/sessions/${s.id}/servers/stop`, {}); toast('Workspace servers stopped'); }
  catch (e) { toast(errMessage(e), true); }
}

export async function openEditor(p: string): Promise<void> {
  try { await api('POST', '/api/open', { path: p }); }
  catch (e) { toast(errMessage(e), true); }
}

/* ---------------- features / fleet ---------------- */

/**
 * Feature-name (or `adopt:<path>`) keys with an action in flight, so Fleet can show a
 * disabled "working…" in place of the row's buttons.
 */
class Pending {
  #keys = $state(new Set<string>());

  has(key: string): boolean { return this.#keys.has(key); }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.#keys = new Set([...this.#keys, key]);
    try { return await fn(); }
    finally {
      const next = new Set(this.#keys);
      next.delete(key);
      this.#keys = next;
    }
  }
}
export const pending = new Pending();

export function startFeatureSession(f: Feature) {
  return pending.run(f.name, async () => {
    try {
      const r = await api('POST', '/api/group/session', { group: f.name });
      if (r.session) {
        // ui.select(), not a bare selectedId write: the store keeps exactly one of
        // selectedId / selectedFeatureName non-null, and Dock tests the feature first.
        // Assigning the id directly left the feature selection standing, so starting an
        // agent from a sessionless feature kept FeaturePane on screen while the
        // ActionBar — which tests the session first — switched to session verbs.
        ui.select(r.session.id);
        toast(r.existed ? 'Session already open — “Go to session ▸”' : `Session started for ${f.name} — “Go to session ▸”`);
      }
    } catch (e) { toast(errMessage(e), true); }
  });
}

// Summarize a /group/start answer. `ok` is the server's verdict (false unless every
// member came up), so the toast never reports a stack where nothing started as a
// success — which is what "started 0/3" used to look like on the stop-and-switch path.
function startResult(verb: string, r: { started: number; total: number; failures?: unknown[] }): string {
  const failed = (r.failures || []).length;
  return `${verb} ${r.started}/${r.total}${failed ? ` (${failed} failed)` : ''}`;
}

export function runStack(name: string) {
  return pending.run(name, async () => {
    try {
      const r = await api('POST', '/api/group/start', { group: name });
      if (r.needsConfirm) {
        const names = [...new Set(r.conflicts.map((c: { wtname: string }) => c.wtname))];
        const list = names.map((n) => `“${n}”`).join(', ');
        const ok = await uiConfirm(
          `${list} ${names.length > 1 ? 'are' : 'is'} already running in the same repo. Stop ${names.length > 1 ? 'them' : 'it'} and switch to “${name}”?`,
          { title: 'Stop & switch?', okLabel: 'Stop & switch' },
        );
        if (!ok) return;
        const r2 = await api('POST', '/api/group/start', { group: name, stopConflicts: true });
        toast(startResult('Switched — started', r2), !r2.ok);
      } else {
        toast(startResult('Started', r), !r.ok);
      }
    } catch (e) { toast(errMessage(e), true); }
  });
}

export function stopStack(name: string) {
  return pending.run(name, async () => {
    try { await api('POST', '/api/group/stop', { group: name }); toast(`Stopped ${name}`); }
    catch (e) { toast(errMessage(e), true); }
  });
}

export function restartStack(name: string) {
  return pending.run(name, async () => {
    try { await api('POST', '/api/group/restart', { group: name }); toast(`Restarting ${name}`); }
    catch (e) { toast(errMessage(e), true); }
  });
}

export async function openGroup(name: string): Promise<void> {
  try { await api('POST', '/api/group/open', { group: name }); }
  catch (e) { toast(errMessage(e), true); }
}

export function prFeature(name: string) {
  return pending.run(name, async () => {
    try {
      toast('Opening PR / MR…');
      const r = await api('POST', '/api/group/pr', { group: name });
      await showPrResults(r);
    } catch (e) { toast(errMessage(e), true); }
  });
}

/**
 * The PR/MR result dialog. `messageHtml` is built here from server-supplied repo names,
 * URLs and error strings — escaped, because a branch or error message is not ours.
 */
export interface PrResult {
  repo: string;
  url?: string;
  error?: string;
}

export async function showPrResults(r: { results?: PrResult[] }): Promise<void> {
  const html = (r.results || []).map((x) => (x.url
    ? `<div>${esc(x.repo)}: <a href="${esc(x.url)}" target="_blank" rel="noreferrer" class="link">${esc(x.url)}</a></div>`
    : `<div>${esc(x.repo)}: <span style="color:var(--waiting)">${esc(x.error)}</span></div>`)).join('');
  await uiDialog({ title: 'Pull / merge requests', messageHtml: html || 'No results', okLabel: 'Done', cancelLabel: '' });
}

export async function closeFeature(name: string) {
  const ok = await uiConfirm(
    `Close feature “${name}”? Stops its servers and deactivates its sessions (worktrees kept).`,
    { title: 'Close feature', okLabel: 'Close' },
  );
  if (!ok) return;
  return pending.run(name, async () => {
    try { await api('POST', '/api/group/close', { group: name }); toast(`Closed ${name}`); }
    catch (e) { toast(errMessage(e), true); }
  });
}

export async function deleteFeature(f: Feature) {
  const ms = liveMembers(f);
  const anyMerged = ms.some((m) => m.merged);
  const r0 = await uiDialog({
    title: `Delete feature “${f.name}”?`,
    message: `Kills its sessions and removes its worktree(s) in ${ms.length} repo(s).`,
    fields: [{ type: 'checkbox', label: 'Also delete the branches', value: anyMerged }],
    okLabel: 'Delete',
    danger: true,
  });
  if (!Array.isArray(r0)) return;
  const deleteBranches = Boolean(r0[0]);
  return pending.run(f.name, async () => {
    try {
      const r = await api('POST', '/api/group/delete', { group: f.name, deleteBranches });
      toast(r.ok ? `Deleted ${f.name}` : 'Some removals failed', !r.ok);
    } catch (e) { toast(errMessage(e), true); }
  });
}

/**
 * Install a worktree's dependencies.
 *
 * `git worktree add` cannot bring node_modules across, so every worktree this app makes
 * starts unable to run its own dev server. Doing it on demand rather than during
 * promote keeps promote fast for the many features that never run a server.
 */
export async function installDeps(w: { repo: string; path: string }): Promise<void> {
  return pending.run(`deps:${w.path}`, async () => {
    toast(`Installing dependencies in ${w.repo}…`);
    try {
      const r = await api('POST', '/api/worktrees/install-deps', { worktreePath: w.path });
      toast(r.ok ? `${w.repo} is ready` : (r.error || 'install failed'), !r.ok);
    } catch (e) { toast(errMessage(e), true); }
  });
}

export async function stopMainServer(w: { repo: string; path: string }): Promise<void> {
  try {
    await api('POST', '/api/servers/stop', { repo: w.repo, worktreePath: w.path });
    toast(`Stopped ${w.repo}`);
  } catch (e) { toast(errMessage(e), true); }
}

/** Minimal escaper for the one place we still hand a dialog raw HTML. */
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

function esc(s: unknown): string {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ESCAPES[c]);
}
