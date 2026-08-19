/*
 * Which blocking overlays are up, in the order they were opened.
 *
 * A STACK, not an ordered list of booleans. Any of these can legitimately open over any
 * other — ⌘K works from anywhere, and "Search transcripts" and "Settings" are both
 * palette commands — so which one Escape should close is a fact about what happened, not
 * something a file can decide in advance. The previous version hardcoded the order as
 * palette, search, settings, intake; open the palette, run Settings from it and press
 * Escape, and the palette closed while Settings, the thing you were looking at, stayed up.
 *
 * The booleans remain as derived reads, because every consumer asks `overlays.settings`
 * and none of them should have to know there is a stack.
 */

import { dialogs } from '$lib/stores/dialog.svelte.js';

/** Every blocking surface, in the order Escape will unwind them. */
export type OverlayName = 'intake' | 'settings' | 'palette' | 'search';

class Overlays {
  /** Bottom-first. The last entry is what is on top and what Escape closes. */
  #stack = $state<OverlayName[]>([]);

  /** Push to the top, moving it there if it is already open rather than duplicating. */
  #open(name: OverlayName): void {
    this.#stack = [...this.#stack.filter((n) => n !== name), name];
  }

  #close(name: OverlayName): void {
    if (name === 'settings') this.settingsSection = null;
    this.#stack = this.#stack.filter((n) => n !== name);
  }

  get intake(): boolean {
    return this.#stack.includes('intake');
  }
  get settings(): boolean {
    return this.#stack.includes('settings');
  }
  get palette(): boolean {
    return this.#stack.includes('palette');
  }
  /**
   * Transcript search.
   *
   * An OVERLAY, not a destination. Search was previously a section inside the
   * session-scoped Insights tab, and then a drill-down inside the fleet-wide Insights
   * view — buried both times, because in both it was something you reached only after
   * arriving somewhere else for a different reason. Insights is gone entirely now; search
   * is its own verb: ⌘⇧F from anywhere, like every editor's search-across-everything.
   */
  get search(): boolean {
    return this.#stack.includes('search');
  }

  openIntake(): void {
    this.#open('intake');
  }
  closeIntake(): void {
    this.#close('intake');
  }
  /**
   * The settings panel to open on, for a caller that already knows which one it means.
   *
   * Null means "wherever it was", which is the right default for the ⋮ menu and ⌘,. It is
   * set by the surfaces that opened Settings to fix ONE named thing — "Asana is not
   * connected" should not land you on a sidebar and leave you to find it.
   *
   * Cleared by #close, so it cannot survive an Escape and re-aim the NEXT visit. That is
   * a leak the old escape() had: it flipped the boolean and left this set.
   */
  settingsSection = $state<string | null>(null);

  openSettings(section: string | null = null): void {
    this.settingsSection = section;
    this.#open('settings');
  }
  closeSettings(): void {
    this.#close('settings');
  }
  togglePalette(): void {
    if (this.palette) this.#close('palette');
    else this.#open('palette');
  }
  closePalette(): void {
    this.#close('palette');
  }
  openSearch(): void {
    // Search opens OVER the palette, since "Search transcripts" is one of its commands.
    this.#close('palette');
    this.#open('search');
  }
  closeSearch(): void {
    this.#close('search');
  }

  /** True while anything blocking is on screen — global shortcuts stand down. */
  get any(): boolean {
    return this.#stack.length > 0 || dialogs.queue.length > 0;
  }

  /** Close the topmost overlay. Returns true if something was closed. */
  escape(): boolean {
    const top = this.#stack[this.#stack.length - 1];
    if (!top) return false;
    this.#close(top);
    return true;
  }
}

export const overlays = new Overlays();
