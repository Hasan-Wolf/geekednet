/**
 * Lab schema validation (guards the §6 promise that "adding a lab is adding a
 * JSON file").
 *
 * Lab content is JSON, so TypeScript never sees it: a typo'd field name, or a
 * `null` where a string belongs, sails straight through the registry's import and
 * reaches the engine as an objective that can never be satisfied. That failure is
 * silent — the student configures everything correctly, the objective stays grey,
 * and it reads as a bug in the simulator rather than in the lab.
 *
 * These checks run when the registry loads and throw instead, naming the lab, the
 * objective and the field. A broken lab is a loud authoring error at startup, not
 * an unwinnable one at play time.
 */

import { ipToInt, maskToPrefix } from './ip.js';
import type { Lab, Predicate } from './types.js';

/** Thrown when lab content does not match the schema the engine evaluates. */
export class LabSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LabSchemaError';
  }
}

type PredicateType = Predicate['type'];

/** The field names of one predicate variant, minus its `type` discriminant. */
type FieldOf<T extends PredicateType> = Exclude<keyof Extract<Predicate, { type: T }>, 'type'>;

interface FieldSpec<T extends PredicateType> {
  /** Must be present, and a non-empty string. */
  required: readonly FieldOf<T>[];
  /** May be absent; when present, still a non-empty string. */
  optional?: readonly FieldOf<T>[];
  /**
   * Alternatives, of which exactly one must be present (and a non-empty string).
   * Neither is an under-specified predicate; both is an author contradicting
   * themselves, and whichever the engine picked would silently win.
   */
  exactlyOne?: readonly FieldOf<T>[];
  /** Must parse as a dotted-quad IPv4 address. */
  addresses?: readonly FieldOf<T>[];
  /** Must parse as a contiguous IPv4 subnet mask. */
  masks?: readonly FieldOf<T>[];
  /** Must compile as a regular expression. */
  regexes?: readonly FieldOf<T>[];
}

/**
 * Every predicate the engine understands, and the fields each one takes.
 *
 * Keyed by `Predicate['type']`, so adding a variant to the union is a compile
 * error here until its fields are declared — this table and the switch in
 * {@link checkPredicate} cannot drift apart.
 */
const PREDICATE_SCHEMA: { [T in PredicateType]: FieldSpec<T> } = {
  // `toDevice` is a device id, so it gets no address check — it is validated by
  // being resolvable at play time, which the lab's own tests walk.
  canPing: { required: ['from'], exactlyOne: ['toIp', 'toDevice'], addresses: ['toIp'] },
  ifaceHasIp: {
    required: ['device', 'iface', 'ip'],
    optional: ['mask'],
    addresses: ['ip'],
    masks: ['mask'],
  },
  // `mask` is required, unlike on `ifaceHasIp`: without it there is no network to
  // be inside of, and no way to tell a host address from a broadcast address.
  ifaceInNetwork: {
    required: ['device', 'iface', 'network', 'mask'],
    addresses: ['network'],
    masks: ['mask'],
  },
  hasRoute: {
    required: ['device', 'dst', 'mask', 'gateway'],
    addresses: ['dst', 'gateway'],
    masks: ['mask'],
  },
  commandRun: { required: ['matches'], regexes: ['matches'] },
  answerEquals: { required: ['key', 'value'] },
};

/** The predicate types {@link checkPredicate} implements. */
export const PREDICATE_TYPES = Object.keys(PREDICATE_SCHEMA) as PredicateType[];

export function isPredicateType(type: unknown): type is PredicateType {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(PREDICATE_SCHEMA, type);
}

/** Render a rejected value for an error message. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check one predicate. `where` locates it for the author ("tier2-static-route.learn
 * objective o1") and prefixes every message.
 */
export function validatePredicate(predicate: unknown, where: string): void {
  if (!isRecord(predicate)) {
    throw new LabSchemaError(`${where}: check must be an object, got ${describe(predicate)}`);
  }

  const { type } = predicate;
  if (!isPredicateType(type)) {
    throw new LabSchemaError(
      `${where}: unknown predicate type ${describe(type)} — known types: ${PREDICATE_TYPES.join(', ')}`,
    );
  }

  // The spec's field names are typed per variant; erase them to plain strings to
  // walk a predicate that is still `unknown`-shaped at this point.
  const spec = PREDICATE_SCHEMA[type] as FieldSpec<PredicateType>;
  const required = spec.required as readonly string[];
  const optional = (spec.optional ?? []) as readonly string[];
  const exactlyOne = (spec.exactlyOne ?? []) as readonly string[];
  const known = ['type', ...required, ...optional, ...exactlyOne];
  const at = `${where}: ${type} predicate`;

  // A misspelled field would otherwise read as "absent" and be silently ignored.
  for (const key of Object.keys(predicate)) {
    if (!known.includes(key)) {
      throw new LabSchemaError(`${at} has unknown field "${key}" (expected: ${known.join(', ')})`);
    }
  }

  for (const key of required) {
    if (!(key in predicate)) {
      throw new LabSchemaError(`${at} is missing required field "${key}"`);
    }
  }

  if (exactlyOne.length > 0) {
    const present = exactlyOne.filter((key) => key in predicate);
    if (present.length !== 1) {
      throw new LabSchemaError(
        `${at} needs exactly one of ${exactlyOne.join(', ')} — found ` +
          (present.length === 0 ? 'neither' : present.join(' and ')),
      );
    }
  }

  // `null` is what an author reaches for to mean "leave this one open", but no
  // predicate field means anything without a value — omitting it does that job.
  for (const key of [...required, ...optional, ...exactlyOne]) {
    if (!(key in predicate)) continue;
    const value = predicate[key];
    if (typeof value !== 'string' || value.trim() === '') {
      const hint = value === null || value === undefined ? ' (omit the field instead)' : '';
      throw new LabSchemaError(
        `${at} field "${key}" must be a non-empty string, got ${describe(value)}${hint}`,
      );
    }
  }

  // Beyond "is a string": an address or mask the engine can't parse equals nothing
  // a student can type, which is an unwinnable objective by another route.
  for (const key of (spec.addresses ?? []) as readonly string[]) {
    const value = predicate[key];
    if (value === undefined) continue;
    try {
      ipToInt(value as string);
    } catch {
      throw new LabSchemaError(
        `${at} field "${key}" must be an IPv4 address, got ${describe(value)}`,
      );
    }
  }

  for (const key of (spec.masks ?? []) as readonly string[]) {
    const value = predicate[key];
    if (value === undefined) continue;
    try {
      maskToPrefix(value as string);
    } catch {
      throw new LabSchemaError(
        `${at} field "${key}" must be a contiguous IPv4 subnet mask, got ${describe(value)}`,
      );
    }
  }

  for (const key of (spec.regexes ?? []) as readonly string[]) {
    const value = predicate[key];
    if (value === undefined) continue;
    try {
      new RegExp(value as string);
    } catch (err) {
      throw new LabSchemaError(
        `${at} field "${key}" must be a valid regular expression: ${(err as Error).message}`,
      );
    }
  }
}

function requireString(value: unknown, where: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LabSchemaError(`${where}: ${field} must be a non-empty string, got ${describe(value)}`);
  }
  return value;
}

/**
 * Check a lab's objectives, plus the sign-off ping whose mismatch parks a lab in
 * `awaiting-verification` forever. Returns the same object, now typed — so the
 * registry validates where it used to cast.
 *
 * This is deliberately not a full schema check of every device and link: the
 * simulator already treats bad device config as "unreachable", and each lab's own
 * tests walk its topology. What's checked here is the part that fails silently by
 * producing an objective no student can complete.
 */
export function validateLab(lab: unknown): Lab {
  if (!isRecord(lab)) {
    throw new LabSchemaError(`lab must be an object, got ${describe(lab)}`);
  }
  const id = requireString(lab.id, 'lab', 'id');

  if (!Array.isArray(lab.objectives)) {
    throw new LabSchemaError(`${id}: objectives must be an array, got ${describe(lab.objectives)}`);
  }

  lab.objectives.forEach((objective: unknown, i: number) => {
    if (!isRecord(objective)) {
      throw new LabSchemaError(
        `${id} objective #${i}: must be an object, got ${describe(objective)}`,
      );
    }
    const objectiveId = requireString(objective.id, `${id} objective #${i}`, 'id');
    const where = `${id} objective ${objectiveId}`;
    requireString(objective.description, where, 'description');
    validatePredicate(objective.check, where);
  });

  if (lab.verify !== undefined) {
    if (!isRecord(lab.verify)) {
      throw new LabSchemaError(`${id}: verify must be an object, got ${describe(lab.verify)}`);
    }
    const verify = lab.verify;
    requireString(verify.from, `${id} verify`, 'from');

    // Same "exactly one" rule as the canPing predicate, for the same reason: a
    // verify naming neither destination can never match a run of the terminal,
    // and one naming both hides which of them the engine actually honours.
    const { toIp, toDevice } = verify;
    const named = ['toIp', 'toDevice'].filter((key) => verify[key] !== undefined);
    if (named.length !== 1) {
      throw new LabSchemaError(
        `${id} verify: needs exactly one of toIp, toDevice — found ` +
          (named.length === 0 ? 'neither' : named.join(' and ')),
      );
    }

    if (toIp !== undefined) {
      const addr = requireString(toIp, `${id} verify`, 'toIp');
      try {
        ipToInt(addr);
      } catch {
        throw new LabSchemaError(
          `${id} verify: toIp must be an IPv4 address, got ${describe(addr)}`,
        );
      }
    } else {
      requireString(toDevice, `${id} verify`, 'toDevice');
    }
  }

  return lab as unknown as Lab;
}

/** Validate a whole registry, in order. */
export function validateLabs(labs: readonly unknown[]): Lab[] {
  return labs.map((lab) => validateLab(lab));
}
