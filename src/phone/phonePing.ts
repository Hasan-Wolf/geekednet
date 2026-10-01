/**
 * Which ping the phone's one button sends.
 *
 * The phone has a single action, so it has to be the right one: the trip that
 * demonstrates what the lab just built. A lab already names it — `Lab.verify` is
 * the ping the lab is signed off with on desktop — so that is what the button
 * runs, resolved through the engine's own `verifyTargetIp` so a lab naming its
 * destination by device (because the address is the student's choice) works the
 * same as one naming an address outright.
 *
 * A lab that declares no sign-off ping — and a Learn Topology shape, which is
 * not a lab at all — falls back to `demoPing`, the derivation Learn Topology
 * already uses: first host to the addressed host furthest from it by cable, the
 * run that actually crosses the shape. Nothing is authored for the phone either
 * way, and the button means the same thing in both of its sections: send the
 * trip worth watching.
 */
import {
  deviceOwningIp,
  getDevice,
  verifyTargetIp,
  type Lab,
  type NetworkState,
} from '../../engine/index.js';
import { demoPing } from '../topologies/index.js';

/** A ping the phone can run and name on its button. */
export interface PhonePing {
  /** Device whose shell the ping runs from. */
  fromId: string;
  fromLabel: string;
  /** Address it is aimed at. */
  toIp: string;
  /** Label of whatever currently owns `toIp`, when something does. */
  toLabel?: string;
}

/**
 * The ping worth showing for this network, or null when it has nothing to ping
 * (no addressed hosts, or a sender that isn't there).
 *
 * `lab` is null for a Learn Topology shape: there is no mission behind it, so
 * there is no sign-off ping to honour and the derivation is all there is.
 *
 * Takes the live network rather than any authored `initialState` so it names the
 * addresses actually on the canvas — including the ones `solveLab` chose.
 */
export function phonePing(lab: Lab | null, net: NetworkState): PhonePing | null {
  const from = lab?.verify ? getDevice(net, lab.verify.from) : undefined;
  const toIp = lab ? verifyTargetIp(lab, net) : undefined;
  if (from && toIp) {
    return {
      fromId: from.id,
      fromLabel: from.label,
      toIp,
      toLabel: deviceOwningIp(net, toIp)?.label,
    };
  }

  const suggestion = demoPing(net);
  if (!suggestion) return null;
  return {
    fromId: suggestion.from.id,
    fromLabel: suggestion.from.label,
    toIp: suggestion.toIp,
    toLabel: suggestion.to.label,
  };
}
