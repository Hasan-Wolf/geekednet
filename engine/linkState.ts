/**
 * Layer-1 health: what the link light on a real box would be doing.
 *
 * This is deliberately separate from {@link simulatePacket}. Reachability asks
 * "could a packet get from here to there", which depends on addressing, masks
 * and routes. This asks the much smaller question a status LED answers: is this
 * port actually connected to something that is actually on, and did the two ends
 * agree on how to talk. A device can be perfectly cabled and still unreachable,
 * and the two indicators should not be confused for one another.
 *
 * Everything here is a pure query over {@link NetworkState}, so it holds for any
 * topology and any lab — including one a student built from an empty canvas. No
 * lab has to opt in, and none can special-case it.
 */

import type { DeviceKind, NetworkState } from './types.js';
import { getDevice, getLink, otherEnd } from './simulate.js';

/**
 * What a port or a device is doing right now.
 *
 *  - `up`       connected to a powered peer, both ends agreeing on layer 1
 *  - `degraded` connected, but not working properly — the amber light
 *  - `down`     no cable, a cable to nothing, or a peer that is switched off
 *
 * There is no fourth state for "powered on but unplugged": that is `down`, which
 * is the point. A box with nothing in its socket must never show green.
 */
export type LinkHealth = 'up' | 'degraded' | 'down';

export interface LinkStatus {
  health: LinkHealth;
  /** Why, in words a learner can act on. Surfaced as the indicator's tooltip. */
  reason: string;
}

/**
 * Devices whose entire job is passing frames between ports.
 *
 * One live link is not a working switch — it is a switch connected to one thing
 * with nothing to forward to. That is a real, visible degradation, and it is
 * what makes pulling one cable in a two-PC lab show up at the switch as well as
 * at the PC. A router is excluded: it still terminates traffic on one interface.
 */
const FORWARDER_KINDS: ReadonlySet<DeviceKind> = new Set<DeviceKind>(['switch', 'hub']);

/** The state of one port. */
export function interfaceLinkStatus(
  state: NetworkState,
  deviceId: string,
  ifaceId: string,
): LinkStatus {
  const device = getDevice(state, deviceId);
  const iface = device?.interfaces.find((i) => i.id === ifaceId);
  if (!device || !iface) return { health: 'down', reason: 'no such interface' };
  if (!device.powered) return { health: 'down', reason: `${device.label} is powered off` };
  if (!iface.linkId) return { health: 'down', reason: `${iface.name}: no cable attached` };

  const link = getLink(state, iface.linkId);
  const far = link ? otherEnd(link, deviceId, ifaceId) : undefined;
  const peer = far ? getDevice(state, far.deviceId) : undefined;
  const peerIface = peer?.interfaces.find((i) => i.id === far!.ifaceId);
  // A linkId pointing at a cable, or an end, that is no longer there. The store
  // clears these as it removes things, so this is a belt-and-braces path rather
  // than an expected one — but a dangling port is down, never green.
  if (!peer || !peerIface) return { health: 'down', reason: `${iface.name}: cable goes nowhere` };
  if (!peer.powered) {
    return { health: 'down', reason: `${iface.name}: ${peer.label} at the far end is powered off` };
  }

  // Layer-1 disagreements. Only when both ends actually state a value — one side
  // alone means "not specified", which is auto-negotiation, not a fault.
  if (iface.speed !== undefined && peerIface.speed !== undefined && iface.speed !== peerIface.speed) {
    return {
      health: 'degraded',
      reason: `${iface.name}: speed mismatch with ${peer.label} (${iface.speed} vs ${peerIface.speed} Mb/s)`,
    };
  }
  if (iface.duplex && peerIface.duplex && iface.duplex !== peerIface.duplex) {
    return {
      health: 'degraded',
      reason: `${iface.name}: duplex mismatch with ${peer.label} (${iface.duplex} vs ${peerIface.duplex})`,
    };
  }

  return { health: 'up', reason: `${iface.name}: link up to ${peer.label}` };
}

/**
 * One indicator for a whole device, summarised from its ports.
 *
 * Ports with no cable in them are not counted as faults — a six-port switch
 * using two of them is a normal switch, not a broken one. What is counted is a
 * port that holds a cable which is not working, and the case of a device with
 * nothing plugged in at all.
 *
 * Worst state wins, so the indicator can never be greener than the unhealthiest
 * thing it is standing for.
 */
export function deviceLinkStatus(state: NetworkState, deviceId: string): LinkStatus {
  const device = getDevice(state, deviceId);
  if (!device) return { health: 'down', reason: 'no such device' };
  if (!device.powered) return { health: 'down', reason: `${device.label} is powered off` };

  const cabled = device.interfaces.filter((i) => i.linkId);
  if (cabled.length === 0) {
    return { health: 'down', reason: `${device.label}: nothing plugged in` };
  }

  const statuses = cabled.map((i) => interfaceLinkStatus(state, deviceId, i.id));

  // A cable that should be carrying a link and is not.
  const down = statuses.find((s) => s.health === 'down');
  if (down) return down;

  if (FORWARDER_KINDS.has(device.kind) && statuses.length < 2) {
    return {
      health: 'degraded',
      reason: `${device.label}: only one live link — nothing to forward between`,
    };
  }

  const degraded = statuses.find((s) => s.health === 'degraded');
  if (degraded) return degraded;

  const n = statuses.length;
  return { health: 'up', reason: `${device.label}: ${n} link${n === 1 ? '' : 's'} up` };
}
