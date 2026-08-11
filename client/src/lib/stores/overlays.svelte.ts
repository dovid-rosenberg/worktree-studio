/*
 * Which blocking overlay is up. Separate booleans rather than one enum because the
 * palette can legitimately open over the intake modal (⌘K works from anywhere), and
 * Escape has to close the topmost one — palette, then search, then settings, then
 * intake.
 */

import { dialogs } from '$lib/stores/dialog.svelte.js';

class Overlays {
  intake = $state(false);
  settings = $state(false);
  palette = $state(false);
  /**
   * Transcript search.
   *
   * An OVERLAY, not a destination. Search was previously a section inside the
   * session-scoped Insights tab, and then a drill-down inside fleet Insights — buried
   * both times, because in both it was something you reached only after arriving
   * somewhere else for a different reason. It is its own verb: ⌘⇧F from anywhere,
   * like every editor's search-across-everything.
   */
  search = $state(false);

  openIntake(): void {
    this.intake = true;
  }
  closeIntake(): void {
    this.intake = false;
  }
  /**
   * The settings panel to open on, for a caller that already knows which one it means.
   *
   * Null means "wherever it was", which is the right default for the ⋮ menu and ⌘,. It is
   * set by the surfaces that opened Settings to fix ONE named thing — "Asana is not
   * connected" should not land you on a sidebar and leave you to find it.
   */
  settingsSection = $state<string | null>(null);

  openSettings(section: string | null = null): void {
    this.settingsSection = section;
    this.settings = true;
  }
  closeSettings(): void {
    this.settings = false;
    this.settingsSection = null;
  }
  togglePalette(): void {
    this.palette = !this.palette;
  }
  closePalette(): void {
    this.palette = false;
  }
  openSearch(): void {
    // Search opens OVER the palette, since "Search transcripts" is one of its commands.
    this.palette = false;
    this.search = true;
  }
  closeSearch(): void {
    this.search = false;
  }

  /** True while anything blocking is on screen — global shortcuts stand down. */
  get any(): boolean {
    return this.palette || this.search || this.settings || this.intake || dialogs.queue.length > 0;
  }

  /** Close the topmost overlay. Returns true if something was closed. */
  escape(): boolean {
    if (this.palette) {
      this.palette = false;
      return true;
    }
    if (this.search) {
      this.search = false;
      return true;
    }
    if (this.settings) {
      this.settings = false;
      return true;
    }
    if (this.intake) {
      this.intake = false;
      return true;
    }
    return false;
  }
}

export const overlays = new Overlays();
