/**
 * Lab registry. The three MVP missions (Build Brief §13) loaded as data.
 *
 * "Adding a lab = adding a JSON file, zero engine changes." New labs are imported
 * here and pushed into `labs`; nothing else in the engine is touched.
 */

import type { Lab } from '../types.js';
import { validateLab } from '../validate.js';
import firstPing from './tier0-first-ping.learn.json' with { type: 'json' };
import fixMask from './tier1-fix-mask.learn.json' with { type: 'json' };
import staticRoute from './tier2-static-route.learn.json' with { type: 'json' };

// `validateLab` replaces the blind `as unknown as Lab` these imports used to need:
// it checks the objectives the engine will evaluate and throws a LabSchemaError
// naming the lab, objective and field. A malformed lab fails at import — loudly,
// on the spot — rather than shipping an objective that can never be completed.
export const tier0FirstPing: Lab = validateLab(firstPing);
export const tier1FixMask: Lab = validateLab(fixMask);
export const tier2StaticRoute: Lab = validateLab(staticRoute);

export const labs: Lab[] = [tier0FirstPing, tier1FixMask, tier2StaticRoute];

export const labsById: Record<string, Lab> = Object.fromEntries(
  labs.map((lab) => [lab.id, lab]),
);

export function getLab(id: string): Lab | undefined {
  return labsById[id];
}
