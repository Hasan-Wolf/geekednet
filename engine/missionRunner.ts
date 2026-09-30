/**
 * Mission runner (Build Brief §11 "mission runner", §12-style checks).
 *
 * Loads a lab's state and the student's actions, then checks win conditions by
 * evaluating each objective's {@link Predicate}. Every predicate reduces to a
 * pure query over {@link NetworkState} (plus optional terminal/answer context for
 * fidelity-B labs). Adding a lab is adding data — this file never changes per lab.
 */

import type {
  EvalContext,
  Lab,
  NetworkState,
  Objective,
  Predicate,
} from './types.js';
import { deviceIp, getDevice, isIpConflicted, ping } from './simulate.js';
import { inNetwork, isHostAddress } from './ip.js';
import { PREDICATE_TYPES } from './validate.js';

/**
 * Where a `canPing` predicate is aimed right now: the address it names, or the
 * current address of the device it names. `undefined` when a named device has no
 * address yet — which reads as "not reachable", because it isn't.
 */
function pingTarget(
  state: NetworkState,
  predicate: Extract<Predicate, { type: 'canPing' }>,
): string | undefined {
  if (predicate.toIp) return predicate.toIp;
  return predicate.toDevice ? deviceIp(state, predicate.toDevice) : undefined;
}

/** Evaluate a single predicate against the current world. */
export function checkPredicate(
  state: NetworkState,
  predicate: Predicate,
  ctx: EvalContext = {},
): boolean {
  switch (predicate.type) {
    case 'canPing': {
      const toIp = pingTarget(state, predicate);
      return !!toIp && ping(state, predicate.from, toIp).success;
    }

    case 'ifaceHasIp': {
      const device = getDevice(state, predicate.device);
      const iface = device?.interfaces.find((i) => i.id === predicate.iface);
      if (!iface) return false;
      if (iface.ip !== predicate.ip) return false;
      if (predicate.mask !== undefined && iface.mask !== predicate.mask) return false;
      return true;
    }

    case 'ifaceInNetwork': {
      const device = getDevice(state, predicate.device);
      const iface = device?.interfaces.find((i) => i.id === predicate.iface);
      if (!iface?.ip) return false;
      // The mask is the lab's, not the student's: it is what makes 192.168.1.50 a
      // host on the /24 the objective names rather than on some other network.
      if (iface.mask !== predicate.mask) return false;
      if (!inNetwork(iface.ip, predicate.network, predicate.mask)) return false;
      // .0 and .255 are inside the /24 and neither is a host: one names the
      // network, the other reaches everyone on it. The simulator delivers frames
      // by address and would happily carry a ping either way, so this check is
      // the only thing between the student and a config real hardware rejects.
      if (!isHostAddress(iface.ip, predicate.mask)) return false;
      // Both PCs on one address is a conflict, not two solved objectives.
      return !isIpConflicted(state, iface.ip);
    }

    case 'hasRoute': {
      const device = getDevice(state, predicate.device);
      if (!device?.routes) return false;
      // All three fields, mask included: dst+gateway alone accepts 20.0.0.0/8 for
      // an objective that asks for 20.0.0.0/24 — a route the simulator then uses
      // for traffic the lab never meant it to carry.
      return device.routes.some(
        (r) =>
          r.dst === predicate.dst &&
          r.mask === predicate.mask &&
          r.gateway === predicate.gateway,
      );
    }

    case 'commandRun': {
      const history = ctx.commandHistory ?? [];
      const re = new RegExp(predicate.matches);
      return history.some((cmd) => re.test(cmd));
    }

    case 'answerEquals': {
      const answers = ctx.answers ?? {};
      return answers[predicate.key] === predicate.value;
    }

    default: {
      // Unreachable for any lab the registry accepted — `validateLab` rejects
      // unknown predicate types at load. A lab assembled in code can still land
      // here, and falling through would return `undefined`, which every caller
      // reads as "not met yet": the objective would stay grey forever with
      // nothing to explain why. Say what happened instead.
      const { type } = predicate as { type?: unknown };
      throw new Error(
        `checkPredicate: unknown predicate type ${JSON.stringify(type)} — ` +
          `known types: ${PREDICATE_TYPES.join(', ')}`,
      );
    }
  }
}

export interface ObjectiveResult {
  id: string;
  description: string;
  complete: boolean;
}

/** Evaluate every objective in a lab, in order. */
export function evaluateObjectives(
  state: NetworkState,
  objectives: Objective[],
  ctx: EvalContext = {},
): ObjectiveResult[] {
  return objectives.map((o) => ({
    id: o.id,
    description: o.description,
    complete: checkPredicate(state, o.check, ctx),
  }));
}

/**
 * Do all of a lab's objectives pass? Note this is the *objective* gate only — a
 * lab that declares a {@link VerifyPing} needs the student's sign-off ping on top
 * of it. Use {@link labStatus} for the question "is this lab finished?".
 */
export function isLabComplete(
  state: NetworkState,
  lab: Lab,
  ctx: EvalContext = {},
): boolean {
  return lab.objectives.every((o) => checkPredicate(state, o.check, ctx));
}

/**
 * Where a lab stands.
 *
 * `awaiting-verification` is the middle state a {@link VerifyPing} introduces:
 * every objective is green and nothing is left to configure, but the student
 * hasn't yet watched a packet prove it. Rewards are withheld there.
 */
export type LabStatus = 'incomplete' | 'awaiting-verification' | 'complete';

/**
 * Gate a lab from its already-evaluated objectives plus whether the verifying
 * ping has landed. Takes results rather than state so callers that just ran
 * {@link evaluateObjectives} don't re-simulate every packet.
 *
 * `verified` is ignored by labs that declare no verifying ping — they complete
 * on objectives alone.
 */
export function labStatus(
  objectives: ObjectiveResult[],
  lab: Lab,
  verified = false,
): LabStatus {
  if (!objectives.every((o) => o.complete)) return 'incomplete';
  if (lab.verify && !verified) return 'awaiting-verification';
  return 'complete';
}

/**
 * The address this lab's sign-off ping must target right now.
 *
 * A lab that pins the destination names the address outright. One whose target
 * address is the student's own choice names the device instead, and it is
 * resolved here — against live state, every time it is asked — so the address
 * the prompt prints and the address the match accepts are the same address the
 * student actually configured.
 *
 * `undefined` for a lab that declares no sign-off ping, and for one whose named
 * device has no address yet.
 */
export function verifyTargetIp(lab: Lab, state: NetworkState): string | undefined {
  const v = lab.verify;
  if (!v) return undefined;
  if (v.toIp) return v.toIp;
  return v.toDevice ? deviceIp(state, v.toDevice) : undefined;
}

/**
 * Is `ping <toIp>` run from device `from` the ping this lab is signed off with?
 * False for every lab that declares none, so callers need no special-casing.
 *
 * Takes `state` because a lab may name its destination by device rather than by
 * address; see {@link verifyTargetIp}.
 */
export function isVerifyPing(
  lab: Lab,
  from: string,
  toIp: string,
  state: NetworkState,
): boolean {
  const v = lab.verify;
  if (!v || v.from !== from) return false;
  const target = verifyTargetIp(lab, state);
  return target !== undefined && target === toIp;
}

/**
 * Full evaluation of a lab attempt: per-objective results plus overall completion
 * and (when complete) the rewards the lab grants. UI/gamification reads this.
 */
export interface LabProgress {
  labId: string;
  objectives: ObjectiveResult[];
  status: LabStatus;
  complete: boolean;
  rewards?: Lab['rewards'];
}

/**
 * `verified` says the lab's {@link VerifyPing} has already been run and
 * succeeded. It defaults to false — labs without one are unaffected either way,
 * and a lab with one should not hand out rewards on a caller's silence.
 */
export function runLab(
  state: NetworkState,
  lab: Lab,
  ctx: EvalContext = {},
  verified = false,
): LabProgress {
  const objectives = evaluateObjectives(state, lab.objectives, ctx);
  const status = labStatus(objectives, lab, verified);
  const complete = status === 'complete';
  return {
    labId: lab.id,
    objectives,
    status,
    complete,
    rewards: complete ? lab.rewards : undefined,
  };
}
