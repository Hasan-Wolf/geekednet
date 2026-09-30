/**
 * What "next lab" means, in one place.
 *
 * The topbar chip and the win cut-in both read from here, so the two can never
 * name different labs. Derived entirely from the lab registry plus the player's
 * unlocked/completed sets — no separate bookkeeping to drift out of sync.
 */
import { useMemo } from 'react';
import type { Lab } from '../engine/index.js';
import { useStore } from './store.js';

/** The free-build playground is not a mission; it never counts toward progress. */
const SANDBOX_ID = 'sandbox';

export interface MissionProgress {
  /** Mission labs in registry order, sandbox excluded. */
  missions: Lab[];
  completed: number;
  total: number;
  /** The mission to play next, or null once every one is finished. */
  next: Lab | null;
  /** `next` exists but has not been unlocked yet, so it cannot be loaded. */
  nextLocked: boolean;
  allComplete: boolean;
}

export function missionProgress(
  labs: Lab[],
  unlocked: string[],
  completedLabs: string[],
): MissionProgress {
  const missions = labs.filter((l) => l.id !== SANDBOX_ID);
  const done = (l: Lab) => completedLabs.includes(l.id);
  const completed = missions.filter(done).length;
  // Prefer something the player can actually start. The second lookup only
  // matters if a lab's rewards ever fail to unlock the one behind it — then the
  // chip still names a destination instead of claiming the game is finished.
  const next =
    missions.find((l) => !done(l) && unlocked.includes(l.id)) ??
    missions.find((l) => !done(l)) ??
    null;

  return {
    missions,
    completed,
    total: missions.length,
    next,
    nextLocked: !!next && !unlocked.includes(next.id),
    allComplete: completed === missions.length,
  };
}

/** Store-bound view of {@link missionProgress}. Selects the three primitives it
 *  depends on separately, so the derived object is only rebuilt when one of them
 *  actually changes. */
export function useMissionProgress(): MissionProgress {
  const labs = useStore((s) => s.labs);
  const unlocked = useStore((s) => s.unlocked);
  const completedLabs = useStore((s) => s.completedLabs);
  return useMemo(
    () => missionProgress(labs, unlocked, completedLabs),
    [labs, unlocked, completedLabs],
  );
}
