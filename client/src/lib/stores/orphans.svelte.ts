/*
 * Conversations whose session is gone, and which can be brought back.
 *
 * PULLED, not pushed. This changes when you close a session — rare — and answering it
 * costs a `git branch` per repo, because a worktree that no longer exists has to be found
 * through the branch that would recreate it. Putting that on the topology frame would run
 * it whenever a file changed.
 *
 * Refreshed when the topology's feature list changes, which is the only thing that can
 * make an orphan appear or disappear.
 */
import { api } from '$lib/api.js';

export interface Orphan {
  worktreePath: string;
  repo: string;
  name: string;
  branch: string;
  claudeSessionId: string;
  lastModified: number;
  conversations: number;
  recoverable: boolean;
  reason?: string;
}

class Orphans {
  list = $state<Orphan[]>([]);
  loading = $state(false);
  /** '' until a fetch has completed at least once — an empty list is not the same as unknown. */
  loadedAt = $state(0);

  async refresh(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const r = await api('GET', '/api/v1/orphans');
      this.list = r.orphans || [];
      this.loadedAt = Date.now();
    } catch {
      // A failure here must not break the rail: the feature simply is not offered.
    } finally {
      this.loading = false;
    }
  }

  /** The resumable conversation for a worktree, if there is one. */
  for(worktreePath: string | null | undefined): Orphan | null {
    if (!worktreePath) return null;
    return this.list.find((o) => o.worktreePath === worktreePath && o.recoverable) || null;
  }

  /** Any resumable conversation among a feature's members. */
  forPaths(paths: string[]): Orphan | null {
    for (const p of paths) {
      const hit = this.for(p);
      if (hit) return hit;
    }
    return null;
  }
}

export const orphans = new Orphans();
