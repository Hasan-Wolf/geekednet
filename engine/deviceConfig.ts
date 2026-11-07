/**
 * What can be configured on a device of a given kind.
 *
 * Three facts about the data model that two very different places need to agree
 * on: the config panel, which decides which inputs to render, and replay
 * validation, which has to reject a step asking for an input that does not
 * exist. Before this they were two copies of the same three lists, and a step
 * setting a gateway on a switch would have been accepted and then done nothing
 * visible — the silent failure the lab schema checks exist to prevent.
 *
 * These are questions about the *kind*, not about one device: a switch has no
 * layer-3 address because switches don't, not because this one isn't wired up.
 */

import type { DeviceKind } from './types.js';

/**
 * The kinds that terminate traffic rather than carry it — the machines a student
 * thinks of as "a computer". Their subnet mask is what defines "who is local"
 * (see `checkMaskAgreement` in simulate.ts) and they are the kinds that carry a
 * default gateway.
 */
export const END_HOST_KINDS: ReadonlySet<DeviceKind> = new Set(['pc', 'laptop', 'server']);

/** Kinds that forward frames without reading addresses: no layer-3 config. */
const LAYER2_KINDS: ReadonlySet<DeviceKind> = new Set(['switch', 'hub']);

/** Kinds that carry a routing table the student can edit. */
const ROUTING_KINDS: ReadonlySet<DeviceKind> = new Set(['router']);

export function isEndHost(kind: DeviceKind): boolean {
  return END_HOST_KINDS.has(kind);
}

/** Does an interface on this kind of device take an IP and mask? */
export function isAddressable(kind: DeviceKind): boolean {
  return !LAYER2_KINDS.has(kind);
}

/** Does this kind of device take a default gateway? */
export function hasDefaultGateway(kind: DeviceKind): boolean {
  return isEndHost(kind);
}

/** Does this kind of device take static routes? */
export function hasRoutingTable(kind: DeviceKind): boolean {
  return ROUTING_KINDS.has(kind);
}
