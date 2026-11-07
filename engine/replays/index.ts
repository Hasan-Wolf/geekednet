/**
 * Replay registry, the same shape as the lab registry next door: adding a
 * replay is adding a JSON file and one line here, with zero engine changes.
 *
 * Registration validates twice — the replay's own shape, then every id it names
 * against the lab it drives — so a renamed device or a dropped objective breaks
 * at import, naming the replay and the step, rather than producing a video of a
 * lab quietly not being solved.
 */

import { getLab } from '../labs/index.js';
import { ReplaySchemaError, validateReplay, validateReplayAgainstLab } from '../replay.js';
import type { Replay } from '../replay.js';
import tier2Walkthrough from './tier2-static-route.walkthrough.json' with { type: 'json' };

function register(raw: unknown): Replay {
  const replay = validateReplay(raw);
  const lab = getLab(replay.labId);
  if (!lab) {
    throw new ReplaySchemaError(
      `replay ${replay.id}: labId "${replay.labId}" is not in the lab registry`,
    );
  }
  validateReplayAgainstLab(replay, lab);
  return replay;
}

export const tier2StaticRouteWalkthrough: Replay = register(tier2Walkthrough);

export const replays: Replay[] = [tier2StaticRouteWalkthrough];

export const replaysById: Record<string, Replay> = Object.fromEntries(
  replays.map((replay) => [replay.id, replay]),
);

export function getReplay(id: string): Replay | undefined {
  return replaysById[id];
}
