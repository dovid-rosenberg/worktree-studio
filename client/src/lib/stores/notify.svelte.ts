/*
 * Attention notifications — the port of app.js's detectAttention / fireAttention /
 * updateAttentionUI / playBeep.
 *
 * The rule that matters: a session alerts only on a real transition INTO waiting (or
 * idle) from a *known* different state. A session first seen on this tick — the
 * initial snapshot, or one just created — is recorded and never alerted, so opening
 * the app with five waiting sessions is silent instead of firing five notifications.
 *
 * The visual half (the `● (n)` title prefix and the Fleet badge) is always on and is
 * derived from the live session list; only the desktop notification and the beep are
 * gated by prefs.
 */

import { api } from '$lib/api.js';
import { ui } from '$lib/stores/ui.svelte.js';
import type { Session, SessionStatePayload } from '../../../../server/types';

/** id → the state we last saw for that session. */
const prevSessionState = new Map<string, string>();

let audioCtx: AudioContext | null = null;

/** The two transitions worth interrupting someone for. */
export type AttentionKind = 'waiting' | 'idle';

export interface NotifyPrefs {
  waiting: boolean;
  sound: boolean;
  idle: boolean;
}

class Notify {
  /** Mirrors config.notify on the daemon; loaded once at boot, updated on save. */
  prefs = $state<NotifyPrefs>({ waiting: true, sound: true, idle: false });
  /** Number of sessions currently waiting — the badge and the title prefix. */
  waitingCount = $state(0);

  async loadPrefs(): Promise<void> {
    try {
      const d = await api('GET', '/api/v1/settings');
      if (d?.notify) this.prefs = { ...this.prefs, ...d.notify };
    } catch {
      /* the settings modal will surface a real failure */
    }
  }

  /**
   * Diff an incoming `session-state` frame against the previous one. Must be called
   * with the frame BEFORE it is swapped into the store, which is why the stream hands
   * it over rather than this module reading the store.
   */
  onSessionFrame(frame: SessionStatePayload | null | undefined): void {
    const sessions = frame?.sessions || [];
    const seen = new Set<string>();
    for (const s of sessions) {
      seen.add(s.id);
      const prev = prevSessionState.get(s.id);
      if (prev !== undefined && prev !== s.state) {
        if (s.state === 'waiting') this.#fire(s, 'waiting');
        else if (s.state === 'idle' && this.prefs.idle) this.#fire(s, 'idle');
      }
      prevSessionState.set(s.id, s.state);
    }
    for (const id of [...prevSessionState.keys()]) if (!seen.has(id)) prevSessionState.delete(id);
    this.waitingCount = sessions.filter((s) => s.state === 'waiting').length;
  }

  #fire(s: Session, kind: AttentionKind): void {
    const wantDesktop = kind === 'waiting' ? this.prefs.waiting : this.prefs.idle;
    if (wantDesktop) desktopNotification(s, kind);
    if (this.prefs.sound) playBeep();
  }

  /** Ask for permission at the moment the user opts in, not on page load. */
  requestPermission(): void {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  }
}

export const notify = new Notify();

function desktopNotification(s: Session, kind: AttentionKind): void {
  if (!('Notification' in window)) return;
  // Already watching this session — the tab title and the badge are enough.
  if (s.id === ui.selectedId && document.hasFocus()) return;
  if (Notification.permission === 'denied') return;
  const fire = () => {
    const title = kind === 'waiting' ? `${s.repoName} needs your input` : `${s.repoName} — turn complete`;
    const body = s.activity || s.title || '';
    try {
      const n = new Notification(title, { body, tag: `wts-${s.id}` });
      n.onclick = () => {
        ui.goToSession(s.id);
        window.focus();
        n.close();
      };
    } catch {
      /* some platforms throw on construction */
    }
  };
  if (Notification.permission === 'granted') fire();
  else
    Notification.requestPermission()
      .then((p) => {
        if (p === 'granted') fire();
      })
      .catch(() => {});
}

/**
 * Short (~120 ms) WebAudio beep. The context is created lazily and may be suspended
 * until a user gesture — degrade silently rather than throw into the SSE handler.
 */
export function playBeep(): void {
  try {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const t0 = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.14, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.13);
  } catch {
    /* no audio — silent */
  }
}
