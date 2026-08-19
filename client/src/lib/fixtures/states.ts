/*
 * Every shape the action bar takes, named once.
 *
 * Shared by /gallery and by the snapshot test, so the page you review and the thing CI
 * asserts are the same list. Adding a state here adds a gallery cell AND a test case;
 * that coupling is the point — a thirteenth state cannot appear unnoticed.
 *
 * Each entry applies itself to the stores rather than describing a world declaratively:
 * selection lives in `ui` and topology in `world`, and a state is a fact about both.
 */
import type * as Fx from './world.js';

/**
 * What a state needs from the stores, and nothing more.
 *
 * Structural rather than the concrete store classes: a state installs three halves and
 * moves the selection, and naming only that keeps this file from importing the runes
 * modules — which is what lets the snapshot test run without a component context.
 */
export interface StateWorld {
  topology: unknown;
  sessionHalf: unknown;
  ciHalf: unknown;
}
export interface StateUi {
  clearSelection(): void;
  selectFeature(f: ReturnType<typeof Fx.feature>): void;
  applySelection(s: { kind: 'session'; id: string }): void;
}

export interface GalleryState {
  name: string;
  /** What this state is FOR — the condition a reviewer should recognise. */
  note: string;
  apply: (fx: typeof Fx, world: StateWorld, ui: StateUi) => void;
}

type W = StateWorld;
type U = StateUi;

export const GALLERY_STATES: GalleryState[] = [
  {
    name: 'nothing selected',
    note: 'The bar prompts instead of sitting empty.',
    apply: (fx, world: W, ui: U) => {
      fx.install(world, fx.makeWorld());
      ui.clearSelection();
    },
  },
  {
    name: 'feature · stopped, startable',
    note: 'Start is a split button: one click for the default slot, caret to choose.',
    apply: (fx, world: W, ui: U) => {
      const f = fx.feature();
      fx.install(world, fx.makeWorld({ features: [f] }));
      ui.selectFeature(f);
    },
  },
  {
    name: 'feature · running',
    note: 'Stop and restart replace start; the slot badge becomes the move control.',
    apply: (fx, world: W, ui: U) => {
      const f = fx.feature({ members: [fx.member({ running: true, ports: [1231] })], slot: 1 });
      fx.install(world, fx.makeWorld({ features: [f] }));
      ui.selectFeature(f);
    },
  },
  {
    name: 'feature · deps missing',
    note: 'Offered where the problem is visible, rather than letting start half-fail.',
    apply: (fx, world: W, ui: U) => {
      const f = fx.feature({ members: [fx.member({ canStart: false, depsMissing: true })] });
      fx.install(world, fx.makeWorld({ features: [f] }));
      ui.selectFeature(f);
    },
  },
  {
    name: 'feature · no start command',
    note: 'Not startable, and for a different reason than missing deps.',
    apply: (fx, world: W, ui: U) => {
      const f = fx.feature({ members: [fx.member({ canStart: false, noStartCmd: true })] });
      fx.install(world, fx.makeWorld({ features: [f] }));
      ui.selectFeature(f);
    },
  },
  {
    name: 'feature · multi-repo, mixed',
    note: 'One repo up, one down — the partial state a stack spends most of its life in.',
    apply: (fx, world: W, ui: U) => {
      const f = fx.feature({
        members: [
          fx.member({ repo: 'accept-blue', running: true, ports: [1231] }),
          fx.member({ repo: 'merchant-v3' }),
        ],
      });
      fx.install(world, fx.makeWorld({ features: [f] }));
      ui.selectFeature(f);
    },
  },
  {
    name: 'session · working',
    note: 'The agent is mid-tool-call; pause and restart-terminal are the verbs.',
    apply: (fx, world: W, ui: U) => {
      const s = fx.session({ state: 'working' });
      const f = fx.feature({ session: fx.embedded({ state: 'working' }) });
      fx.install(world, fx.makeWorld({ features: [f], sessions: [s] }));
      ui.applySelection({ kind: 'session', id: s.id });
    },
  },
  {
    name: 'session · waiting',
    note: 'The one state worth interrupting someone for.',
    apply: (fx, world: W, ui: U) => {
      const s = fx.session({ state: 'waiting', activity: 'Needs your answer' });
      const f = fx.feature({ session: fx.embedded({ state: 'waiting' }) });
      fx.install(world, fx.makeWorld({ features: [f], sessions: [s] }));
      ui.applySelection({ kind: 'session', id: s.id });
    },
  },
  {
    name: 'session · stopped',
    note: 'Resumable: the process is gone, the conversation is not.',
    apply: (fx, world: W, ui: U) => {
      const s = fx.session({ state: 'stopped', active: false });
      const f = fx.feature({ session: fx.embedded({ state: 'stopped' }) });
      fx.install(world, fx.makeWorld({ features: [f], sessions: [s] }));
      ui.applySelection({ kind: 'session', id: s.id });
    },
  },
  {
    name: 'session · unpromoted',
    note: 'Running in a main checkout, so promote is the verb that matters.',
    apply: (fx, world: W, ui: U) => {
      const s = fx.session({ worktree: null, worktreePath: null, branch: null, repos: [] });
      fx.install(world, fx.makeWorld({ features: [], sessions: [s] }));
      ui.applySelection({ kind: 'session', id: s.id });
    },
  },
];
