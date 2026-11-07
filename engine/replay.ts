/**
 * Replay schema — a lab, played through itself.
 *
 * A replay is a lab id plus an ordered list of steps that drive that lab from
 * its deliberately-broken starting state to a finished one: the same edits and
 * the same sign-off ping a student would perform. It exists so a lab can be
 * *shown* — the app opened at `?lab=<labId>&replay=<replayId>` plays the lab
 * through itself, and `scripts/record.ts` films exactly that.
 *
 * Three rules keep a replay honest, and the first two are why this file is in
 * the engine rather than beside the recorder:
 *
 *  1. A step names lab data only — a device id, an interface id, an objective
 *     id, an address. Never a CSS selector, a pixel, a keystroke or a frame
 *     number. A replay stays valid for as long as the lab's *data* is, and
 *     survives any amount of re-styling or re-layout.
 *
 *  2. Nothing here renders or animates. The runner (`src/replay.ts`) dispatches
 *     every step through the same store actions the UI binds to its own inputs,
 *     so a replayed run and a student's run are one code path. `runPacket` ends
 *     in the terminal's own `ping`, which is `simulatePacket` both ways — there
 *     is no second, scripted way for a packet to cross the canvas.
 *
 *  3. A replay can only ask for something the lab can actually do. The content
 *     is JSON, so it is checked at import — an unknown step type, a misspelled
 *     field, a device the lab doesn't have, an objective id that no longer
 *     exists, or a gateway set on a switch is a loud startup error naming the
 *     replay and the step. Silence is the one failure mode worth engineering
 *     against: a replay that quietly skips half its steps still produces a
 *     video, and nobody notices until they watch it.
 *
 * Nothing in here is lab-specific. Every lab in the curriculum is a graph of
 * devices with config state, and these five steps are the whole surface a
 * student can touch, so a Defend or Attack tier lab is replayable the day its
 * JSON lands — see {@link validateReplayAgainstLab}, which asks the lab what it
 * contains rather than knowing anything about any particular one.
 */

import {
  hasDefaultGateway,
  hasRoutingTable,
  isAddressable,
} from './deviceConfig.js';
import { ipToInt, maskToPrefix } from './ip.js';
import { describe, isNonEmptyString, isRecord } from './schema.js';
import { deviceIp } from './simulate.js';
import type { Device, Lab, NetworkState } from './types.js';

/** Thrown when replay content does not match the schema the runner executes. */
export class ReplaySchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplaySchemaError';
  }
}

// --- Step types ------------------------------------------------------------

/**
 * The device fields a `configure` step may set — one per editable control in
 * the config panel, which is the entire surface a student has for changing a
 * device.
 */
export const CONFIGURE_FIELDS = ['ip', 'mask', 'gateway', 'powered'] as const;
export type ConfigureField = (typeof CONFIGURE_FIELDS)[number];

/** `powered` is a toggle, so its value is a word rather than an address. */
export const POWER_VALUES = ['on', 'off'] as const;

interface StepNote {
  /** Author's aside. Carried for whoever reads the JSON; the runner ignores it. */
  note?: string;
}

interface PacedStep extends StepNote {
  /**
   * How long to hold after the step lands, in ms, overriding the runner's
   * default for the type. This is pacing for a viewer — the state change itself
   * is synchronous — so it is the one number in the schema that is about the
   * video rather than about the network.
   */
  settleMs?: number;
}

/** Set one field on one device, exactly as typing into the config panel does. */
export interface ConfigureStep extends PacedStep {
  type: 'configure';
  deviceId: string;
  /** Required for `ip` and `mask`; rejected for `gateway` and `powered`. */
  interfaceId?: string;
  field: ConfigureField;
  /** `on`/`off` for `powered`, a dotted quad otherwise. */
  value: string;
}

/**
 * Append a static route to a router, as clicking "+ Add route" and filling the
 * three columns does. Its own step type rather than a `configure` field: a route
 * is three values that only mean anything together, and half a route is a route
 * the simulator would try to use.
 */
export interface AddRouteStep extends PacedStep {
  type: 'addRoute';
  deviceId: string;
  dst: string;
  mask: string;
  gateway: string;
}

/**
 * Ping from a device, through the terminal the student types into.
 *
 * Exactly one of `dstIp` / `dstDevice`, mirroring the `canPing` predicate and
 * for the same reason: a lab that lets the student choose the target's address
 * cannot name that address up front, so it names the machine and the address is
 * resolved from live state when the step runs. See {@link runPacketTarget}.
 */
export interface RunPacketStep extends PacedStep {
  type: 'runPacket';
  /** Device id the ping is run from — the terminal's active device. */
  src: string;
  dstIp?: string;
  dstDevice?: string;
}

/** Hold still. For letting a previous step's animation or banner be read. */
export interface WaitStep extends StepNote {
  type: 'wait';
  ms: number;
}

/** Draw the eye to one objective in the list before the step that satisfies it. */
export interface HighlightStep extends PacedStep {
  type: 'highlight';
  objectiveId: string;
}

export type ReplayStep =
  | ConfigureStep
  | AddRouteStep
  | RunPacketStep
  | WaitStep
  | HighlightStep;

export type ReplayStepType = ReplayStep['type'];

export interface Replay {
  /** "tier2-static-route.walkthrough" — the id `?replay=` names. */
  id: string;
  /** The lab this drives. Must be in the lab registry. */
  labId: string;
  title?: string;
  description?: string;
  steps: ReplayStep[];
}

// --- Schema table ----------------------------------------------------------

/** The field names of one step variant, minus its `type` discriminant. */
type FieldOf<T extends ReplayStepType> = Exclude<
  keyof Extract<ReplayStep, { type: T }>,
  'type'
>;

interface StepSpec<T extends ReplayStepType> {
  /** Must be present. */
  required: readonly FieldOf<T>[];
  /** May be absent; still checked when present. */
  optional?: readonly FieldOf<T>[];
  /** Exactly one of these must be present — neither is under-specified, both is
   *  an author contradicting themselves. */
  exactlyOne?: readonly FieldOf<T>[];
  /** Must parse as a dotted-quad IPv4 address. */
  addresses?: readonly FieldOf<T>[];
  /** Must parse as a contiguous IPv4 subnet mask. */
  masks?: readonly FieldOf<T>[];
  /** A duration in ms: a finite number, zero or more. Not a string. */
  durations?: readonly FieldOf<T>[];
  /** Must be one of a fixed set of words. */
  words?: { readonly [K in FieldOf<T>]?: readonly string[] };
}

/**
 * Every step the runner understands, and the fields each one takes.
 *
 * Keyed by `ReplayStep['type']`, so adding a variant to the union is a compile
 * error here until its fields are declared — this table and the dispatch switch
 * in `src/replay.ts` cannot drift apart without the build saying so.
 */
const STEP_SCHEMA: { [T in ReplayStepType]: StepSpec<T> } = {
  configure: {
    required: ['deviceId', 'field', 'value'],
    optional: ['interfaceId', 'note', 'settleMs'],
    durations: ['settleMs'],
    words: { field: CONFIGURE_FIELDS },
    // `value` is checked against `field` afterwards: an address for ip/gateway,
    // a mask for mask, a word for powered. One table column can't say that.
  },
  addRoute: {
    required: ['deviceId', 'dst', 'mask', 'gateway'],
    optional: ['note', 'settleMs'],
    addresses: ['dst', 'gateway'],
    masks: ['mask'],
    durations: ['settleMs'],
  },
  runPacket: {
    required: ['src'],
    optional: ['note', 'settleMs'],
    exactlyOne: ['dstIp', 'dstDevice'],
    addresses: ['dstIp'],
    durations: ['settleMs'],
  },
  // No `settleMs`: the wait *is* the pause, and a step with two of them would
  // leave an author guessing which one applies.
  wait: { required: ['ms'], optional: ['note'], durations: ['ms'] },
  highlight: {
    required: ['objectiveId'],
    optional: ['note', 'settleMs'],
    durations: ['settleMs'],
  },
};

/** The step types the runner implements. */
export const REPLAY_STEP_TYPES = Object.keys(STEP_SCHEMA) as ReplayStepType[];

export function isReplayStepType(type: unknown): type is ReplayStepType {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(STEP_SCHEMA, type);
}

// --- Shape validation ------------------------------------------------------

/**
 * Check one step's shape. `where` locates it for the author ("replay
 * tier2-static-route.walkthrough step #3") and prefixes every message.
 *
 * This is the shape only — whether the ids it names exist is a question about a
 * lab, and lives in {@link validateReplayAgainstLab}.
 */
export function validateStep(step: unknown, where: string): void {
  if (!isRecord(step)) {
    throw new ReplaySchemaError(`${where}: step must be an object, got ${describe(step)}`);
  }

  const { type } = step;
  if (!isReplayStepType(type)) {
    throw new ReplaySchemaError(
      `${where}: unknown step type ${describe(type)} — ` +
        `known types: ${REPLAY_STEP_TYPES.join(', ')}`,
    );
  }

  // The spec's field names are typed per variant; erase them to plain strings to
  // walk a step that is still `unknown`-shaped at this point.
  const spec = STEP_SCHEMA[type] as StepSpec<ReplayStepType>;
  const required = spec.required as readonly string[];
  const optional = (spec.optional ?? []) as readonly string[];
  const exactlyOne = (spec.exactlyOne ?? []) as readonly string[];
  const durations = (spec.durations ?? []) as readonly string[];
  const known = ['type', ...required, ...optional, ...exactlyOne];
  const at = `${where}: ${type} step`;

  // A misspelled field would otherwise read as "absent" and be silently ignored
  // — which for a replay means a video of the lab not being solved.
  for (const key of Object.keys(step)) {
    if (!known.includes(key)) {
      throw new ReplaySchemaError(
        `${at} has unknown field "${key}" (expected: ${known.join(', ')})`,
      );
    }
  }

  for (const key of required) {
    if (!(key in step)) {
      throw new ReplaySchemaError(`${at} is missing required field "${key}"`);
    }
  }

  if (exactlyOne.length > 0) {
    const present = exactlyOne.filter((key) => key in step);
    if (present.length !== 1) {
      throw new ReplaySchemaError(
        `${at} needs exactly one of ${exactlyOne.join(', ')} — found ` +
          (present.length === 0 ? 'neither' : present.join(' and ')),
      );
    }
  }

  for (const key of [...required, ...optional, ...exactlyOne]) {
    if (!(key in step)) continue;
    const value = step[key];
    if (durations.includes(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new ReplaySchemaError(
          `${at} field "${key}" must be a duration in milliseconds ` +
            `(a finite number, zero or more), got ${describe(value)}`,
        );
      }
      continue;
    }
    if (!isNonEmptyString(value)) {
      const hint = value === null || value === undefined ? ' (omit the field instead)' : '';
      throw new ReplaySchemaError(
        `${at} field "${key}" must be a non-empty string, got ${describe(value)}${hint}`,
      );
    }
  }

  for (const key of (spec.addresses ?? []) as readonly string[]) {
    if (!(key in step)) continue;
    assertAddress(step[key], `${at} field "${key}"`);
  }

  for (const key of (spec.masks ?? []) as readonly string[]) {
    if (!(key in step)) continue;
    assertMask(step[key], `${at} field "${key}"`);
  }

  const words = (spec.words ?? {}) as Record<string, readonly string[] | undefined>;
  for (const [key, allowed] of Object.entries(words)) {
    if (!allowed || !(key in step)) continue;
    if (!allowed.includes(step[key] as string)) {
      throw new ReplaySchemaError(
        `${at} field "${key}" must be one of ${allowed.join(', ')} — got ${describe(step[key])}`,
      );
    }
  }

  if (type === 'configure') validateConfigureValue(step, at);
}

function assertAddress(value: unknown, at: string): void {
  try {
    ipToInt(value as string);
  } catch {
    throw new ReplaySchemaError(`${at} must be an IPv4 address, got ${describe(value)}`);
  }
}

function assertMask(value: unknown, at: string): void {
  try {
    maskToPrefix(value as string);
  } catch {
    throw new ReplaySchemaError(
      `${at} must be a contiguous IPv4 subnet mask, got ${describe(value)}`,
    );
  }
}

/**
 * A `configure` step's `value` and `interfaceId` both depend on its `field`, so
 * neither can be a column in the table above.
 *
 * The interface rule is the one that would otherwise fail quietly: a step naming
 * an interface while setting a gateway looks deliberate and does nothing with it.
 */
function validateConfigureValue(step: Record<string, unknown>, at: string): void {
  const field = step.field as ConfigureField;
  const perInterface = field === 'ip' || field === 'mask';

  if (perInterface && !('interfaceId' in step)) {
    throw new ReplaySchemaError(
      `${at} sets "${field}", which belongs to an interface — add "interfaceId"`,
    );
  }
  if (!perInterface && 'interfaceId' in step) {
    throw new ReplaySchemaError(
      `${at} sets "${field}", which belongs to the device, not an interface — drop "interfaceId"`,
    );
  }

  if (field === 'powered') {
    if (!(POWER_VALUES as readonly string[]).includes(step.value as string)) {
      throw new ReplaySchemaError(
        `${at} field "value" must be one of ${POWER_VALUES.join(', ')} when field is ` +
          `"powered" — got ${describe(step.value)}`,
      );
    }
    return;
  }
  if (field === 'mask') {
    assertMask(step.value, `${at} field "value"`);
    return;
  }
  assertAddress(step.value, `${at} field "value"`);
}

/**
 * Check a replay's shape. Returns the same object, now typed — so the registry
 * validates where it would otherwise cast.
 */
export function validateReplay(replay: unknown): Replay {
  if (!isRecord(replay)) {
    throw new ReplaySchemaError(`replay must be an object, got ${describe(replay)}`);
  }
  if (!isNonEmptyString(replay.id)) {
    throw new ReplaySchemaError(`replay: id must be a non-empty string, got ${describe(replay.id)}`);
  }
  const id = replay.id;
  if (!isNonEmptyString(replay.labId)) {
    throw new ReplaySchemaError(
      `replay ${id}: labId must be a non-empty string, got ${describe(replay.labId)}`,
    );
  }
  for (const key of ['title', 'description'] as const) {
    if (replay[key] !== undefined && !isNonEmptyString(replay[key])) {
      throw new ReplaySchemaError(
        `replay ${id}: ${key} must be a non-empty string, got ${describe(replay[key])}`,
      );
    }
  }
  if (!Array.isArray(replay.steps)) {
    throw new ReplaySchemaError(
      `replay ${id}: steps must be an array, got ${describe(replay.steps)}`,
    );
  }
  // An empty replay records a static screenshot of the broken starting state and
  // calls it a walkthrough. Almost certainly a half-written file.
  if (replay.steps.length === 0) {
    throw new ReplaySchemaError(`replay ${id}: steps is empty — a replay must do something`);
  }

  replay.steps.forEach((step: unknown, i: number) => {
    validateStep(step, `replay ${id} step #${i}`);
  });

  return replay as unknown as Replay;
}

// --- Cross-checking a replay against its lab -------------------------------

function findDevice(state: NetworkState, id: string): Device | undefined {
  return state.devices.find((d) => d.id === id);
}

/**
 * Check that every id a replay names exists in the lab it drives, and that every
 * field it sets is one that kind of device actually has.
 *
 * This is the half of validation that catches a *renamed* lab rather than a
 * malformed replay: rename `pc1` to `host1` in the lab JSON and this says so at
 * startup, instead of the replay running to completion having configured
 * nothing. Device ids are checked against the lab's `initialState`, which is
 * where the replay starts — a replay never adds devices.
 */
export function validateReplayAgainstLab(replay: Replay, lab: Lab): void {
  if (replay.labId !== lab.id) {
    throw new ReplaySchemaError(
      `replay ${replay.id}: drives lab "${replay.labId}", checked against "${lab.id}"`,
    );
  }
  const state = lab.initialState;
  const objectiveIds = new Set(lab.objectives.map((o) => o.id));

  const device = (id: string, at: string): Device => {
    const found = findDevice(state, id);
    if (!found) {
      const known = state.devices.map((d) => d.id).join(', ') || '(none)';
      throw new ReplaySchemaError(
        `${at}: lab ${lab.id} has no device "${id}" — known devices: ${known}`,
      );
    }
    return found;
  };

  replay.steps.forEach((step, i) => {
    const at = `replay ${replay.id} step #${i}: ${step.type}`;

    switch (step.type) {
      case 'configure': {
        const dev = device(step.deviceId, at);
        if (step.interfaceId !== undefined) {
          if (!isAddressable(dev.kind)) {
            throw new ReplaySchemaError(
              `${at}: ${dev.label} is a ${dev.kind} — a layer-2 port has no IP or mask to set`,
            );
          }
          if (!dev.interfaces.some((iface) => iface.id === step.interfaceId)) {
            const known = dev.interfaces.map((iface) => iface.id).join(', ') || '(none)';
            throw new ReplaySchemaError(
              `${at}: ${dev.label} has no interface "${step.interfaceId}" — known: ${known}`,
            );
          }
        }
        if (step.field === 'gateway' && !hasDefaultGateway(dev.kind)) {
          throw new ReplaySchemaError(
            `${at}: ${dev.label} is a ${dev.kind} — only end hosts take a default gateway`,
          );
        }
        return;
      }

      case 'addRoute': {
        const dev = device(step.deviceId, at);
        if (!hasRoutingTable(dev.kind)) {
          throw new ReplaySchemaError(
            `${at}: ${dev.label} is a ${dev.kind} — only routers take static routes`,
          );
        }
        return;
      }

      case 'runPacket': {
        device(step.src, `${at} (src)`);
        if (step.dstDevice) device(step.dstDevice, `${at} (dstDevice)`);
        return;
      }

      case 'highlight': {
        if (!objectiveIds.has(step.objectiveId)) {
          const known = [...objectiveIds].join(', ') || '(none)';
          throw new ReplaySchemaError(
            `${at}: lab ${lab.id} has no objective "${step.objectiveId}" — known: ${known}`,
          );
        }
        return;
      }

      case 'wait':
        return;

      default: {
        // Unreachable for any replay the registry accepted. A replay assembled in
        // code can still land here, and falling through would skip the step in
        // silence — the one outcome this file exists to prevent.
        const { type } = step as { type?: unknown };
        throw new ReplaySchemaError(
          `${at}: unknown step type ${describe(type)} — ` +
            `known types: ${REPLAY_STEP_TYPES.join(', ')}`,
        );
      }
    }
  });
}

/**
 * The address a `runPacket` step is aimed at right now: the one it names, or the
 * current address of the device it names.
 *
 * `undefined` when a named device has no address yet — which reads as "there is
 * nothing to ping", because there isn't. Mirrors `pingTarget` in missionRunner,
 * so a replay's ping and a `canPing` objective resolve a device the same way.
 */
export function runPacketTarget(state: NetworkState, step: RunPacketStep): string | undefined {
  if (step.dstIp) return step.dstIp;
  return step.dstDevice ? deviceIp(state, step.dstDevice) : undefined;
}
