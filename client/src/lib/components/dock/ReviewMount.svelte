<script lang="ts">
  import type { Session } from '../../../../../server/types';
  /*
   * The Changes / review panel, mounted into the dock.
   *
   * This file stays a seam rather than a direct import in Dock.svelte: the shell and the
   * review panel were built on separate branches, so exactly one file knows the panel's
   * shape. Everything the panel needs it fetches itself from `sessionId`.
   *
   * Contract the dock guarantees:
   *  - Rendered only while `ui.dockView === 'changes'`, and only for a session with a
   *    `worktreePath` (the ✎ Changes tab is hidden otherwise).
   *  - `session` is the live, stitched session object — it updates in place as frames
   *    arrive, so the panel is not remounted on a state change.
   *  - The panel owns the full remaining height of the dock, above the server bar.
   *
   * `{#key sessionId}` rather than `{#key session}`: ReviewPanel loads commits on mount
   * and holds its own selection, so switching sessions must start it over — but a
   * `session-state` frame for the SAME session must not. `session` is a fresh object on
   * every frame (the store derives it), so keying on the object would remount the panel
   * several times a second and throw away the user's selected commit.
   */
  import ReviewPanel from '$lib/components/review/ReviewPanel.svelte';

  /**
   * `onchangescount` is accepted and unused: ReviewPanel exposes no such callback, and
   * Dock.svelte already fetches the badge count itself. Kept in the signature so the
   * dock's call site isn't silently dropping a prop.
   */
  let { session }: { session?: Session; onchangescount?: (n: number) => void } = $props();

  const sessionId = $derived(session?.id ?? null);
</script>

{#if sessionId}
  {#key sessionId}
    <ReviewPanel {sessionId} />
  {/key}
{/if}
