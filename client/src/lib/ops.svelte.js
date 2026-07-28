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
import { uiConfirm, uiDialog, uiPrompt } from '$lib/stores/dialog.svelte.js';
import { world } from '$lib/stores/world.svelte.js';
import { ui } from '$lib/stores/ui.svelte.js';

/* ---------------- sessions ---------------- */

/** @param {any} s */
export async function promote(s) {
  const branch = await uiPrompt('Branch to create for this worktree:', s.suggestedBranch || 'feature/x');
  if (!branch) return;
  try {
    let r = await api('POST', `/api/sessions/${s.id}/promote`, { branch });
    // Dirty main → warn before stranding pre-promote edits (they stay in main).
    if (r.needsConfirm) {
      const n = (r.dirty || []).length;
      const ok = await uiConfirm(
        `Your main checkout has ${n} uncommitted change(s) that will stay in main, not move to the new worktree. Promote anyway?`,
        { title: 'Uncommitted changes in main', okLabel: 'Promote anyway', danger: true },
      );
      if (!ok) return;
      r = await api('POST', `/api/sessions/${s.id}/promote`, { branch, confirm: true });
    }
    const w = r.worktree || {};
    const warn = (w.warnings || []).find((/** @type {string} */ x) => /taken/.test(x));
    toast(warn ? `Promoted as “${w.name}” — ${warn}` : `Promoted → ${w.branch || branch}`);
  } catch (e) { toast(/** @type {Error} */ (e).message, true); }
}

/** @param {any} s */
export async function popout(s) {
  try {
    await api('POST', `/api/sessions/${s.id}/popout`, {});
    toast('Popped out to a native terminal (same live session).');
  } catch (e) { toast(/** @type {Error} */ (e).message, true); }
}

/** @param {any} s */
export async function addRepoToSession(s) {
  const have = new Set((s.repos || []).map((/** @type {any} */ r) => r.repo));
  const avail = world.repos.map((/** @type {any} */ r) => r.name).filter((/** @type {string} */ n) => !have.has(n));
  if (!avail.length) return toast('No other repos to add.', true);
  const r0 = await uiDialog({
    title: 'Add a repo to this feature',
    message: 'Creates a same-named worktree there and gives the session access.',
    fields: [{ type: 'select', label: 'Repo', value: avail[0], options: avail }],
    okLabel: 'Add',
  });
  if (!r0) return;
  const pick = r0[0];
  if (!avail.includes(pick)) return;
  try {
    const r = await api('POST', `/api/sessions/${s.id}/add-repo`, { repo: pick });
    toast(r.already ? `${pick} already in feature` : `Added ${pick} → ${r.worktree.name}`);
  } catch (e) { toast(/** @type {Error} */ (e).message, true); }
}

/** @param {any} s */
export async function addTab(s) {
  const title = await uiPrompt('New tab name:', 'shell');
  if (title === null) return;
  try {
    await api('POST', `/api/sessions/${s.id}/tabs`, { title: title || 'shell' });
    toast(`Tab “${title || 'shell'}” added`);
  } catch (e) { toast(/** @type {Error} */ (e).message, true); }
}

/**
 * @param {any} s
 * @param {number} i
 */
export async function selectTab(s, i) {
  ui.dockView = 'term';
  ui.activeTab = i;
  try { await api('POST', `/api/sessions/${s.id}/select-tab`, { index: i }); }
  catch (e) { toast(/** @type {Error} */ (e).message, true); }
}

/**
 * @param {any} s
 * @param {number} i
 */
export async function closeTab(s, i) {
  try {
    await api('POST', `/api/sessions/${s.id}/close-tab`, { index: i });
    toast('Tab closed');
  } catch (e) { toast(/** @type {Error} */ (e).message, true); }
}

/** @param {any} s */
export async function closeSession(s) {
  const ok = await uiConfirm(`Delete “${s.title}”? This kills its ${world.mux} session and removes it.`, {
    title: 'Delete session', okLabel: 'Delete', danger: true,
  });
  if (!ok) return;
  try {
    await api('DELETE', `/api/sessions/${s.id}`);
    if (ui.selectedId === s.id) ui.selectedId = null;
    toast('Session deleted');
  } catch (e) { toast(/** @type {Error} */ (e).message, true); }
}

/** @param {any} s */
export async function renameSession(s) {
  const title = await uiPrompt('Rename session:', s.title);
  if (title === null || !title.trim()) return;
  try { await api('POST', `/api/sessions/${s.id}/rename`, { title }); toast('Renamed'); }
  catch (e) { toast(/** @type {Error} */ (e).message, true); }
}

/** @param {any} s */
export async function deactivateSession(s) {
  const ok = await uiConfirm(
    `Deactivate “${s.title}”? Stops the process; you can resume it later to continue the conversation.`,
    { title: 'Deactivate', okLabel: 'Deactivate' },
  );
  if (!ok) return;
  try { await api('POST', `/api/sessions/${s.id}/deactivate`, {}); toast('Deactivated'); }
  catch (e) { toast(/** @type {Error} */ (e).message, true); }
}

/** @param {any} s */
export async function activateSession(s) {
  try { await api('POST', `/api/sessions/${s.id}/activate`, {}); toast('Resuming session'); }
  catch (e) { toast(/** @type {Error} */ (e).message, true); }
}

/* ---------------- dev servers ---------------- */

/** @param {any} s */
export async function startSessionServers(s) {
  try {
    const r = await api('POST', `/api/sessions/${s.id}/servers/start`, {});
    toast(r.ok ? 'Workspace servers starting' : 'Some failed to start', !r.ok);
  } catch (e) { toast(/** @type {Error} */ (e).message, true); }
}

/** @param {any} s */
export async function stopSessionServers(s) {
  try { await api('POST', `/api/sessions/${s.id}/servers/stop`, {}); toast('Workspace servers stopped'); }
  catch (e) { toast(/** @type {Error} */ (e).message, true); }
}

/** @param {string} p */
export async function openEditor(p) {
  try { await api('POST', '/api/open', { path: p }); }
  catch (e) { toast(/** @type {Error} */ (e).message, true); }
}

/* ---------------- features / fleet ---------------- */

/**
 * Feature-name (or `adopt:<path>`) keys with an action in flight, so Fleet can show a
 * disabled "working…" in place of the row's buttons.
 */
class Pending {
  /** @type {Set<string>} */
  #keys = $state(new Set());
  /** @param {string} key */
  has(key) { return this.#keys.has(key); }
  /**
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fn
   */
  async run(key, fn) {
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

/** @param {any} f */
export function startFeatureSession(f) {
  return pending.run(f.name, async () => {
    try {
      const r = await api('POST', '/api/group/session', { group: f.name });
      if (r.session) {
        ui.selectedId = r.session.id;
        toast(r.existed ? 'Session already open — “Go to session ▸”' : `Session started for ${f.name} — “Go to session ▸”`);
      }
    } catch (e) { toast(/** @type {Error} */ (e).message, true); }
  });
}

/** @param {string} name */
export function runStack(name) {
  return pending.run(name, async () => {
    try {
      const r = await api('POST', '/api/group/start', { group: name });
      if (r.needsConfirm) {
        const names = [...new Set(r.conflicts.map((/** @type {any} */ c) => c.wtname))];
        const list = names.map((n) => `“${n}”`).join(', ');
        const ok = await uiConfirm(
          `${list} ${names.length > 1 ? 'are' : 'is'} already running in the same repo. Stop ${names.length > 1 ? 'them' : 'it'} and switch to “${name}”?`,
          { title: 'Stop & switch?', okLabel: 'Stop & switch' },
        );
        if (!ok) return;
        const r2 = await api('POST', '/api/group/start', { group: name, stopConflicts: true });
        toast(`Switched — started ${r2.started}/${r2.total}`);
      } else {
        const failed = (r.failures || []).length;
        toast(`Started ${r.started}/${r.total}${failed ? ` (${failed} failed)` : ''}`, !!failed);
      }
    } catch (e) { toast(/** @type {Error} */ (e).message, true); }
  });
}

/** @param {string} name */
export function stopStack(name) {
  return pending.run(name, async () => {
    try { await api('POST', '/api/group/stop', { group: name }); toast(`Stopped ${name}`); }
    catch (e) { toast(/** @type {Error} */ (e).message, true); }
  });
}

/** @param {string} name */
export function restartStack(name) {
  return pending.run(name, async () => {
    try { await api('POST', '/api/group/restart', { group: name }); toast(`Restarting ${name}`); }
    catch (e) { toast(/** @type {Error} */ (e).message, true); }
  });
}

/** @param {string} name */
export async function openGroup(name) {
  try { await api('POST', '/api/group/open', { group: name }); }
  catch (e) { toast(/** @type {Error} */ (e).message, true); }
}

/** @param {string} name */
export function prFeature(name) {
  return pending.run(name, async () => {
    try {
      toast('Opening PR / MR…');
      const r = await api('POST', '/api/group/pr', { group: name });
      await showPrResults(r);
    } catch (e) { toast(/** @type {Error} */ (e).message, true); }
  });
}

/**
 * The PR/MR result dialog. `messageHtml` is built here from server-supplied repo names,
 * URLs and error strings — escaped, because a branch or error message is not ours.
 * @param {any} r
 */
export async function showPrResults(r) {
  const html = (r.results || []).map((/** @type {any} */ x) => (x.url
    ? `<div>${esc(x.repo)}: <a href="${esc(x.url)}" target="_blank" rel="noreferrer" class="link">${esc(x.url)}</a></div>`
    : `<div>${esc(x.repo)}: <span style="color:var(--waiting)">${esc(x.error)}</span></div>`)).join('');
  await uiDialog({ title: 'Pull / merge requests', messageHtml: html || 'No results', okLabel: 'Done', cancelLabel: '' });
}

/** @param {string} name */
export async function closeFeature(name) {
  const ok = await uiConfirm(
    `Close feature “${name}”? Stops its servers and deactivates its sessions (worktrees kept).`,
    { title: 'Close feature', okLabel: 'Close' },
  );
  if (!ok) return;
  return pending.run(name, async () => {
    try { await api('POST', '/api/group/close', { group: name }); toast(`Closed ${name}`); }
    catch (e) { toast(/** @type {Error} */ (e).message, true); }
  });
}

/** @param {any} f */
export async function deleteFeature(f) {
  const ms = f.members.filter((/** @type {any} */ m) => m && !m.missing);
  const anyMerged = ms.some((/** @type {any} */ m) => m.merged);
  const r0 = await uiDialog({
    title: `Delete feature “${f.name}”?`,
    message: `Kills its sessions and removes its worktree(s) in ${ms.length} repo(s).`,
    fields: [{ type: 'checkbox', label: 'Also delete the branches', value: anyMerged }],
    okLabel: 'Delete',
    danger: true,
  });
  if (!r0) return;
  return pending.run(f.name, async () => {
    try {
      const r = await api('POST', '/api/group/delete', { group: f.name, deleteBranches: r0[0] });
      toast(r.ok ? `Deleted ${f.name}` : 'Some removals failed', !r.ok);
    } catch (e) { toast(/** @type {Error} */ (e).message, true); }
  });
}

/** @param {any} w */
export async function stopMainServer(w) {
  try {
    await api('POST', '/api/servers/stop', { repo: w.repo, worktreePath: w.path });
    toast(`Stopped ${w.repo}`);
  } catch (e) { toast(/** @type {Error} */ (e).message, true); }
}

/** Minimal escaper for the one place we still hand a dialog raw HTML. */
function esc(/** @type {unknown} */ s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    /** @type {Record<string,string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
  ));
}
