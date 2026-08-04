/*
 * Which blocking overlay is up. Three booleans rather than one enum because the
 * palette can legitimately open over the intake modal (⌘K works from anywhere), and
 * Escape has to close the topmost one — the same precedence app.js encoded in
 * handleShortcut(): palette, then settings, then intake.
 */

import { dialogs } from '$lib/stores/dialog.svelte.js';

class Overlays {
  intake = $state(false);
  settings = $state(false);
  palette = $state(false);

  openIntake(): void {
    this.intake = true;
  }
  closeIntake(): void {
    this.intake = false;
  }
  openSettings(): void {
    this.settings = true;
  }
  closeSettings(): void {
    this.settings = false;
  }
  togglePalette(): void {
    this.palette = !this.palette;
  }
  closePalette(): void {
    this.palette = false;
  }

  /** True while anything blocking is on screen — global shortcuts stand down. */
  get any(): boolean {
    return this.palette || this.settings || this.intake || dialogs.queue.length > 0;
  }

  /** Close the topmost overlay. Returns true if something was closed. */
  escape(): boolean {
    if (this.palette) {
      this.palette = false;
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
