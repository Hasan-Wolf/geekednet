/**
 * Derive a lab's walkthrough from the lab itself.
 *
 * A lab's `objectives` already state what "solved" means: `ifaceHasIp` names an
 * address an interface must carry, `ifaceInNetwork` names the network it must
 * sit on, `hasRoute` names a route a router is missing, `canPing` names the
 * packet that proves it. `solveLab` in the phone view reads those to show the
 * *end state*; this reads the same ones to produce the *path* to it — the
 * ordered edits a student would make, as a {@link Replay} the existing runner
 * and recorder already know how to play and film.
 *
 * So nothing is authored twice. A replay was a second description of a lab's
 * solution, kept in step with the first by hand; now it is derived from it, and
 * a fourth lab arrives with a walkthrough for the same reason it arrives
 * playable — because its objectives say what it wants.
 *
 * Two properties are worth stating, because they are the whole point:
 *
 *  1. **Loud, not silent.** An objective this cannot drive is a thrown
 *     {@link ReplayGenerationError} naming the lab, the objective and the
 *     predicate — never a replay with that step quietly missing. A generated
 *     walkthrough that skips an objective still produces a video, of the lab
 *     failing to solve itself, and nobody notices until someone watches it. The
 *     same reasoning as `validateReplayAgainstLab`, one step earlier.
 *
 *  2. **Pure, and pure over the lab.** The input is never mutated — a lab's
 *     `initialState` is shared by every session that loads it — and the output
 *     is plain data, checkable by `validateReplay` like any hand-written
 *     replay. Nothing here renders, animates, or knows what plays a replay.
 *
 * Pacing is expressed as an explicit `settleMs` on every step, so a generated
 * replay reads to the runner exactly as an authored one does and carries no
 * dependency on the runner's own defaults.
 */

import { inNetwork, intToIp, ipToInt, isHostAddress, maskToPrefix, pickHostAddress } from './ip.js';
import { deviceIp } from './simulate.js';
import type { AddRouteStep, ConfigureStep, Replay, ReplayStep, RunPacketStep } from './replay.js';
import type { Device, Interface, Lab, NetworkState, Objective, Predicate } from './types.js';

/** Thrown when a lab's objectives do not describe something this can drive. */
export class ReplayGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayGenerationError';
  }
}

/**
 * How long each kind of step holds, in ms.
 *
 * Longer than the runner's own defaults: these are the numbers for a clip
 * someone watches once, where a configure step landing in 700ms reads as a value
 * appearing out of nowhere. The runner's defaults stay what they are, for
 * hand-written replays that omit `settleMs`.
 */
export interface ReplayPace {
  /** Hold on the untouched, broken starting state before anything moves. */
  openHold: number;
  /** After an objective lights up, before the step that satisfies it. */
  highlight: number;
  /** After the last objective lights up — the beat before the proving ping. */
  finalHighlight: number;
  /** After one field is set. */
  configure: number;
  /** After a route is added: three values, so a touch longer. */
  addRoute: number;
  /** Dwell after the packet lands and the win bar appears. */
  runPacket: number;
}

export const DEFAULT_PACE: ReplayPace = {
  openHold: 1400,
  highlight: 900,
  finalHighlight: 1400,
  configure: 1100,
  addRoute: 1200,
  runPacket: 3200,
};

export interface GenerateReplayOptions {
  /** Defaults to the lab id with a `.learn` suffix replaced by `.walkthrough`. */
  id?: string;
  title?: string;
  description?: string;
  /** Per-step holds, merged over {@link DEFAULT_PACE}. */
  pace?: Partial<ReplayPace>;
}

// --- Reading the working network -------------------------------------------

const findDevice = (net: NetworkState, id: string): Device | undefined =>
  net.devices.find((d) => d.id === id);

const findIface = (net: NetworkState, deviceId: string, ifaceId: string): Interface | undefined =>
  findDevice(net, deviceId)?.interfaces.find((i) => i.id === ifaceId);

const labelOf = (net: NetworkState, id: string): string => findDevice(net, id)?.label ?? id;

function addressesInUse(net: NetworkState): Set<string> {
  const out = new Set<string>();
  for (const device of net.devices) {
    for (const iface of device.interfaces) if (iface.ip) out.add(iface.ip);
  }
  return out;
}

/** Does this interface already satisfy an `ifaceInNetwork` check? Mirrors `solveLab`. */
function alreadyInNetwork(
  net: NetworkState,
  iface: Interface,
  network: string,
  mask: string,
): boolean {
  if (!iface.ip || iface.mask !== mask) return false;
  if (!inNetwork(iface.ip, network, mask)) return false;
  if (!isHostAddress(iface.ip, mask)) return false;
  // Two interfaces on one address is a conflict, not two solved objectives — so
  // an address shared with someone else is not "already configured", it is the
  // thing being fixed.
  const others = net.devices
    .flatMap((d) => d.interfaces)
    .filter((i) => i !== iface && i.ip === iface.ip);
  return others.length === 0;
}

/** The subnet an address sits in, for prose. `undefined` if either side is malformed. */
function networkOf(ip: string, mask: string): string | undefined {
  try {
    return intToIp((ipToInt(ip) & ipToInt(mask)) >>> 0);
  } catch {
    return undefined;
  }
}

// --- Emitting steps --------------------------------------------------------

interface Emit {
  steps: ReplayStep[];
  net: NetworkState;
  pace: ReplayPace;
  where: (objective: Objective) => string;
}

function configure(
  emit: Emit,
  deviceId: string,
  interfaceId: string,
  field: 'ip' | 'mask',
  value: string,
  note: string,
): void {
  const step: ConfigureStep = {
    type: 'configure',
    deviceId,
    interfaceId,
    field,
    value,
    settleMs: emit.pace.configure,
    note,
  };
  emit.steps.push(step);
}

/**
 * Set an interface's address, emitting only the fields that actually change.
 *
 * A step setting a field to the value it already holds is a step a viewer
 * watches nothing happen during — and in the mask labs, the field that is
 * already right is precisely the one the lesson is contrasting against.
 */
function address(
  emit: Emit,
  objective: Objective,
  deviceId: string,
  ifaceId: string,
  ip: string,
  mask: string | undefined,
  ipNote: string,
): void {
  const iface = findIface(emit.net, deviceId, ifaceId);
  if (!iface) {
    throw new ReplayGenerationError(
      `${emit.where(objective)}: no interface "${ifaceId}" on device "${deviceId}"`,
    );
  }
  const label = labelOf(emit.net, deviceId);
  if (iface.ip !== ip) {
    configure(emit, deviceId, ifaceId, 'ip', ip, ipNote);
    iface.ip = ip;
  }
  // A check that names no mask is not asking for one; leave what is there.
  if (mask !== undefined && iface.mask !== mask) {
    const had = iface.mask;
    const explain = had
      ? `The mask was ${had} — a /${maskToPrefix(had)} against a /${maskToPrefix(mask)}. ` +
        'That disagreement is what stops the two seeing each other as local.'
      : `The mask that tells ${label} who counts as local.`;
    configure(emit, deviceId, ifaceId, 'mask', mask, explain);
    iface.mask = mask;
  }
}

function runPacket(
  emit: Emit,
  from: string,
  target: { ip?: string; device?: string },
  note: string,
): void {
  const step: RunPacketStep = { type: 'runPacket', src: from, settleMs: emit.pace.runPacket, note };
  // Exactly one of the two, mirroring the schema: `dstIp` when the lab pins an
  // address, `dstDevice` when the student picked it and it is read from state.
  if (target.ip !== undefined) step.dstIp = target.ip;
  else step.dstDevice = target.device;
  emit.steps.push(step);
}

/** Where a `runPacket` step will aim, for comparing against the lab's verify ping. */
function aimOf(step: RunPacketStep, net: NetworkState): string | undefined {
  return step.dstIp ?? (step.dstDevice ? deviceIp(net, step.dstDevice) : undefined);
}

// --- One objective ---------------------------------------------------------

function driveObjective(emit: Emit, objective: Objective, isLast: boolean): void {
  const check: Predicate = objective.check;

  // Draw the eye to the objective before the step that satisfies it.
  emit.steps.push({
    type: 'highlight',
    objectiveId: objective.id,
    settleMs: isLast || check.type === 'canPing' ? emit.pace.finalHighlight : emit.pace.highlight,
    note: objective.description,
  });

  switch (check.type) {
    case 'ifaceHasIp': {
      const subnet = check.mask ? networkOf(check.ip, check.mask) : undefined;
      address(
        emit,
        objective,
        check.device,
        check.iface,
        check.ip,
        check.mask,
        subnet
          ? `${labelOf(emit.net, check.device)} takes the address the objective names, on ${subnet}.`
          : `${labelOf(emit.net, check.device)} takes the address the objective names.`,
      );
      return;
    }

    case 'ifaceInNetwork': {
      const iface = findIface(emit.net, check.device, check.iface);
      if (!iface) {
        throw new ReplayGenerationError(
          `${emit.where(objective)}: no interface "${check.iface}" on device "${check.device}"`,
        );
      }
      if (alreadyInNetwork(emit.net, iface, check.network, check.mask)) return;
      const taken = addressesInUse(emit.net);
      // The interface's own address is not "taken" from its own point of view —
      // it is about to be replaced.
      if (iface.ip) taken.delete(iface.ip);
      const ip = pickHostAddress(check.network, check.mask, taken);
      if (!ip) {
        throw new ReplayGenerationError(
          `${emit.where(objective)}: no free host address left in ` +
            `${check.network}/${maskToPrefix(check.mask)} to satisfy it`,
        );
      }
      address(
        emit,
        objective,
        check.device,
        check.iface,
        ip,
        check.mask,
        `${labelOf(emit.net, check.device)} gets a free host address on ` +
          `${check.network}/${maskToPrefix(check.mask)}.`,
      );
      return;
    }

    case 'hasRoute': {
      const device = findDevice(emit.net, check.device);
      if (!device) {
        throw new ReplayGenerationError(
          `${emit.where(objective)}: no device "${check.device}" to add the route to`,
        );
      }
      device.routes ??= [];
      const already = device.routes.some(
        (r) => r.dst === check.dst && r.mask === check.mask && r.gateway === check.gateway,
      );
      if (already) return;
      const step: AddRouteStep = {
        type: 'addRoute',
        deviceId: check.device,
        dst: check.dst,
        mask: check.mask,
        gateway: check.gateway,
        settleMs: emit.pace.addRoute,
        note:
          `${labelOf(emit.net, check.device)} learns the way to ` +
          `${check.dst}/${maskToPrefix(check.mask)}, via ${check.gateway}.`,
      };
      emit.steps.push(step);
      device.routes.push({ dst: check.dst, mask: check.mask, gateway: check.gateway });
      return;
    }

    case 'canPing': {
      const resolved = check.toIp ?? (check.toDevice ? deviceIp(emit.net, check.toDevice) : undefined);
      const destination = resolved ?? labelOf(emit.net, check.toDevice ?? '');
      runPacket(
        emit,
        check.from,
        { ip: check.toIp, device: check.toDevice },
        `The proving ping: ${labelOf(emit.net, check.from)} → ${destination}.`,
      );
      return;
    }

    // `commandRun` and `answerEquals` are about what the student typed, not
    // about the network, and no replay step types into a fidelity-B terminal.
    // Loud rather than skipped — see this module's header.
    default: {
      const { type } = check as { type?: unknown };
      throw new ReplayGenerationError(
        `${emit.where(objective)}: no step can satisfy a ${JSON.stringify(type)} objective — ` +
          'drivable predicates: ifaceHasIp, ifaceInNetwork, hasRoute, canPing',
      );
    }
  }
}

// --- The generator ---------------------------------------------------------

/**
 * The replay that takes `lab` from its authored starting state to solved.
 *
 * Objectives are driven in the order the lab declares them, which is the order a
 * student would work through them — and it matters for the labs that let the
 * student choose: two interfaces told to sit on one /24 get two different
 * addresses, because the second pick sees what the first one took.
 *
 * @throws {ReplayGenerationError} if an objective names something the lab does
 * not contain, or asks for something no replay step can do.
 */
export function generateReplay(lab: Lab, options: GenerateReplayOptions = {}): Replay {
  const pace = { ...DEFAULT_PACE, ...options.pace };
  const net: NetworkState = structuredClone(lab.initialState);
  const emit: Emit = {
    net,
    pace,
    steps: [],
    where: (objective) => `lab ${lab.id} objective ${objective.id}`,
  };

  // Open on the problem. Without this the first edit lands before a viewer has
  // seen what it is an edit to. One sentence of the brief, not all of it: the
  // rest is the story, and the clip is about the fault.
  const scenario = lab.brief.split(/(?<=\.)\s+/)[0] ?? lab.brief;
  emit.steps.push({
    type: 'wait',
    ms: pace.openHold,
    note: `The starting state, as the lab hands it over: ${scenario}`,
  });

  lab.objectives.forEach((objective, index) => {
    driveObjective(emit, objective, index === lab.objectives.length - 1);
  });

  // The sign-off ping, when the lab declares one that no objective already ran.
  // A lab whose last objective *is* its verify ping (the common shape) needs
  // nothing more; one that verifies a ping its objectives never mention would
  // otherwise end on a green checklist and no packet.
  const verify = lab.verify;
  if (verify) {
    const wanted = verify.toIp ?? (verify.toDevice ? deviceIp(net, verify.toDevice) : undefined);
    const covered = emit.steps.some(
      (step) => step.type === 'runPacket' && step.src === verify.from && aimOf(step, net) === wanted,
    );
    if (!covered) {
      runPacket(
        emit,
        verify.from,
        { ip: verify.toIp, device: verify.toDevice },
        "The lab's sign-off ping — green objectives say the config looks right; " +
          'this says the packet made the trip.',
      );
    }
  }

  const count = lab.objectives.length;
  return {
    id: options.id ?? `${lab.id.replace(/\.learn$/, '')}.walkthrough`,
    labId: lab.id,
    title: options.title ?? `${lab.title} — solved`,
    description:
      options.description ?? `Derived from the lab's ${count} objective${count === 1 ? '' : 's'}.`,
    steps: emit.steps,
  };
}
