/**
 * The simulation step (Build Brief §7) — the heart of the engine.
 *
 * `simulatePacket` is one pure function that answers "can a packet get from A to
 * B right now, and if not, why?". It powers ping, traceroute, and every
 * `canPing` objective check. The `reason` string on a failure is the product:
 * it is fed to hints and the companion bot, so it is written to be read by a
 * human learner.
 *
 * Two deliberate teaching rules go slightly beyond the §7 reference sketch (which
 * the brief says to implement "roughly"):
 *
 *  1. Layer-2 delivery between two hosts on the same segment requires their subnet
 *     masks to MATCH. This encodes the pedagogy of the "fix the mask" mission
 *     ("different mask = the PCs disagree about who's local") — without it, the
 *     specific /24-vs-/25 addresses in that lab would still reach each other and
 *     the objective could never flip. See {@link l2Deliver}.
 *
 *  2. `ping` (as used by the `canPing` objective) is bidirectional: it simulates
 *     the echo request AND the echo reply. A one-way check would mark the
 *     two-router lab complete after only one static route, because the far
 *     network is directly connected on the return router. See {@link ping}.
 *
 *  3. An address is read against its mask before anything is delivered. The
 *     network and broadcast addresses of a subnet are not hosts: nothing may
 *     send from one, a packet aimed at the network address goes nowhere, and one
 *     aimed at the broadcast address is a broadcast — one frame, every host on
 *     the segment, never forwarded by a router. Without this the engine carried
 *     traffic for a host sitting on .0 or .255 exactly as if it were a normal
 *     machine, so a lab could call a network working that no hardware would
 *     bring up. See {@link addressRole} and {@link l2Broadcast}.
 */

import type { Device, Interface, Link, NetworkState, SimResult } from './types.js';
import { LIMITED_BROADCAST, addressRole, inNetwork, sameSubnet } from './ip.js';

// --- Lookups ---------------------------------------------------------------

export function getDevice(state: NetworkState, id: string): Device | undefined {
  return state.devices.find((d) => d.id === id);
}

export function getLink(state: NetworkState, linkId: string): Link | undefined {
  return state.links.find((l) => l.id === linkId);
}

/** The device that has an interface configured with `ip` (powered or not). */
export function deviceOwningIp(state: NetworkState, ip: string): Device | undefined {
  return state.devices.find((d) => d.interfaces.some((i) => i.ip === ip));
}

/**
 * The address a device answers on: the first interface that carries one.
 *
 * Labs that let the student pick an address name the *device* as a ping target
 * rather than a literal IP, and this is what resolves it at check time. End
 * hosts — the only things targeted that way — have exactly one address.
 */
export function deviceIp(state: NetworkState, deviceId: string): string | undefined {
  return getDevice(state, deviceId)?.interfaces.find((i) => i.ip)?.ip ?? undefined;
}

/**
 * Is `ip` configured on two or more interfaces anywhere in the network?
 *
 * On a real wire that is an address conflict and both hosts suffer for it, so an
 * objective that lets a student choose an address must not accept the one the
 * other host already has.
 */
export function isIpConflicted(state: NetworkState, ip: string): boolean {
  let seen = 0;
  for (const device of state.devices) {
    for (const iface of device.interfaces) {
      if (iface.ip === ip && ++seen > 1) return true;
    }
  }
  return false;
}

/** Does `device` have a directly-connected interface whose subnet contains `dstIp`? */
export function deviceOwnsSubnetFor(device: Device, dstIp: string): boolean {
  return device.interfaces.some((i) => i.ip && i.mask && sameSubnet(i.ip, dstIp, i.mask));
}

/** Given a link and one endpoint, return the endpoint on the other side. */
export function otherEnd(
  link: Link,
  deviceId: string,
  ifaceId: string,
): { deviceId: string; ifaceId: string } | undefined {
  if (link.a.deviceId === deviceId && link.a.ifaceId === ifaceId) return link.b;
  if (link.b.deviceId === deviceId && link.b.ifaceId === ifaceId) return link.a;
  return undefined;
}

// --- Firewall --------------------------------------------------------------

/**
 * Evaluate a device's firewall rules in order for an ICMP packet toward `dstIp`.
 * First matching rule wins; if no rule matches, the packet passes (default-allow).
 * None of the three MVP missions use firewalls, but the hook is here so defense
 * labs (Tier 4) are pure content.
 */
export function checkFirewall(
  device: Device,
  outIface: Interface | undefined,
  _dstIp: string,
  proto: 'icmp' | 'tcp' | 'udp' = 'icmp',
): { pass: boolean; reason?: string } {
  const rules = device.firewall;
  if (!rules || rules.length === 0) return { pass: true };

  for (const rule of rules) {
    const protoMatches = !rule.proto || rule.proto === 'any' || rule.proto === proto;
    if (!protoMatches) continue;
    // Zone matching is best-effort: a rule constrained to a zone only applies
    // when the outgoing interface's device carries that zone.
    if (rule.dstZone && rule.dstZone !== device.zone) continue;
    if (rule.action === 'block') {
      return {
        pass: false,
        reason: `${proto.toUpperCase()} traffic denied${
          outIface ? ` out ${outIface.name}` : ''
        }`,
      };
    }
    return { pass: true };
  }
  return { pass: true };
}

// --- Layer 2 delivery ------------------------------------------------------

/**
 * Deliver a frame from `srcIface` to whichever device owns `dstIp`, forwarding
 * across switches and hubs on the same broadcast domain. A switch forwards to the
 * port whose device owns the IP; a hub floods but still delivers. Hosts and
 * routers that are not the target do not forward (L2 stops there).
 *
 * On success, appends the target device to `path`. Enforces teaching rule #1:
 * two IP-bearing hosts must share the same subnet mask to be "local" to each other.
 */
export function l2Deliver(
  state: NetworkState,
  src: Device,
  srcIface: Interface,
  dstIp: string,
  path: string[],
): SimResult {
  const target = deviceOwningIp(state, dstIp);
  if (!target) {
    return { success: false, path, reason: `no device on this network owns ${dstIp}` };
  }
  if (!target.powered) {
    return { success: false, path, reason: `${target.label} is powered off` };
  }
  if (!srcIface.linkId) {
    return { success: false, path, reason: `${src.label} ${srcIface.name} is not connected` };
  }

  // Breadth-first walk of the switched segment. Each queue item is an interface
  // we are about to transmit out of.
  const visited = new Set<string>();
  const queue: Array<{ deviceId: string; ifaceId: string }> = [
    { deviceId: src.id, ifaceId: srcIface.id },
  ];
  visited.add(`${src.id}:${srcIface.id}`);

  while (queue.length > 0) {
    const cur = queue.shift()!;
    const dev = getDevice(state, cur.deviceId);
    const iface = dev?.interfaces.find((i) => i.id === cur.ifaceId);
    if (!dev || !iface?.linkId) continue;

    const link = getLink(state, iface.linkId);
    if (!link) continue;
    const far = otherEnd(link, cur.deviceId, cur.ifaceId);
    if (!far) continue;

    const farDev = getDevice(state, far.deviceId);
    if (!farDev || !farDev.powered) continue;

    if (farDev.id === target.id) {
      // Reached the destination. Enforce mask agreement between two end hosts.
      const targetIface = farDev.interfaces.find((i) => i.id === far.ifaceId);
      const maskCheck = checkMaskAgreement(src, srcIface, farDev, targetIface);
      if (!maskCheck.ok) return { success: false, path, reason: maskCheck.reason };
      if (!path.includes(target.id)) path.push(target.id);
      return { success: true, path };
    }

    // Only switches and hubs forward a frame onward.
    if (farDev.kind === 'switch' || farDev.kind === 'hub') {
      for (const outIface of farDev.interfaces) {
        if (outIface.id === far.ifaceId) continue; // never out the incoming port
        const key = `${farDev.id}:${outIface.id}`;
        if (visited.has(key)) continue;
        visited.add(key);
        queue.push({ deviceId: farDev.id, ifaceId: outIface.id });
      }
    }
    // Any other device kind that is not the target is a dead end for this frame.
  }

  return {
    success: false,
    path,
    reason: `${target.label} is unreachable at layer 2 — check the cabling and switch ports`,
  };
}

/**
 * Would `device` accept a packet addressed to `dstIp`, arriving on `ifaceId`, as
 * a broadcast meant for it?
 *
 * The limited broadcast is for everyone on the wire. A subnet broadcast is only
 * a broadcast to a host whose *own* mask says so: a /25 host on 192.168.1.0 sees
 * 192.168.1.255 as an ordinary address somewhere outside its subnet, not as
 * "everybody", and drops it. That is the same disagreement teaching rule #1
 * exists to surface, read from the receiver's side.
 */
function acceptsBroadcast(device: Device, ifaceId: string, dstIp: string): boolean {
  if (dstIp === LIMITED_BROADCAST) return true;
  const iface = device.interfaces.find((i) => i.id === ifaceId);
  if (!iface?.ip || !iface.mask) return false;
  return sameSubnet(iface.ip, dstIp, iface.mask) && addressRole(dstIp, iface.mask) === 'broadcast';
}

/**
 * Flood a frame across the sender's broadcast domain and report everyone who
 * accepted it.
 *
 * Same walk as {@link l2Deliver}, with no target to stop at: switches and hubs
 * pass it on, every other device kind terminates it, and a router never floods
 * it onward — which is exactly why a broadcast does not leave its segment.
 *
 * `success` means at least one device other than the sender accepted it. A
 * broadcast into a segment where nothing is listening is a real thing to do and
 * a useless thing to have done, and the student is better told so.
 */
export function l2Broadcast(
  state: NetworkState,
  src: Device,
  srcIface: Interface,
  dstIp: string,
  path: string[],
): SimResult {
  if (!srcIface.linkId) {
    return { success: false, path, reason: `${src.label} ${srcIface.name} is not connected` };
  }

  const recipients: string[] = [];
  const visited = new Set<string>([`${src.id}:${srcIface.id}`]);
  const queue: Array<{ deviceId: string; ifaceId: string }> = [
    { deviceId: src.id, ifaceId: srcIface.id },
  ];

  // Breadth-first, so `recipients` comes out nearest-first and `path` can name
  // the closest one as the leg worth drawing.
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const dev = getDevice(state, cur.deviceId);
    const iface = dev?.interfaces.find((i) => i.id === cur.ifaceId);
    if (!dev || !iface?.linkId) continue;

    const link = getLink(state, iface.linkId);
    if (!link) continue;
    const far = otherEnd(link, cur.deviceId, cur.ifaceId);
    if (!far) continue;

    const farDev = getDevice(state, far.deviceId);
    if (!farDev || !farDev.powered) continue;

    if (farDev.kind === 'switch' || farDev.kind === 'hub') {
      for (const outIface of farDev.interfaces) {
        if (outIface.id === far.ifaceId) continue; // never back out the incoming port
        const key = `${farDev.id}:${outIface.id}`;
        if (visited.has(key)) continue;
        visited.add(key);
        queue.push({ deviceId: farDev.id, ifaceId: outIface.id });
      }
      continue;
    }

    // Anything else terminates the frame; whether it keeps the packet is an
    // IP-layer question its own mask answers.
    if (
      farDev.id !== src.id &&
      !recipients.includes(farDev.id) &&
      acceptsBroadcast(farDev, far.ifaceId, dstIp)
    ) {
      recipients.push(farDev.id);
    }
  }

  if (recipients.length === 0) {
    return {
      success: false,
      path,
      reason: `nothing on ${src.label}'s segment accepted the broadcast to ${dstIp}`,
    };
  }

  return {
    success: true,
    path: path.includes(recipients[0]) ? path : [...path, recipients[0]],
    broadcast: true,
    recipients,
  };
}

/** End hosts — the devices whose subnet mask defines "who is local". */
const END_HOST_KINDS: ReadonlySet<Device['kind']> = new Set(['pc', 'laptop', 'server']);

function isEndHost(device: Device): boolean {
  return END_HOST_KINDS.has(device.kind);
}

/**
 * Teaching rule #1: when a frame reaches the destination interface directly at
 * layer 2 and BOTH endpoints are end hosts (pc / laptop / server) carrying an
 * IP/mask, their masks must be equal. A mismatch means the two hosts disagree
 * about the local network. This is scoped to host-to-host only: a host reaching
 * its gateway (a router with a legitimately different mask, e.g. a /30 backbone
 * link elsewhere) is never blocked by this rule.
 */
function checkMaskAgreement(
  src: Device,
  srcIface: Interface,
  dst: Device,
  dstIface: Interface | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (!isEndHost(src) || !isEndHost(dst)) return { ok: true };
  if (!dstIface || !srcIface.ip || !srcIface.mask || !dstIface.ip || !dstIface.mask) {
    return { ok: true };
  }
  if (srcIface.mask !== dstIface.mask) {
    return {
      ok: false,
      reason:
        `${src.label} (${srcIface.mask}) and ${dst.label} (${dstIface.mask}) ` +
        `disagree about the network — their subnet masks differ`,
    };
  }
  return { ok: true };
}

// --- Layer 3 simulation ----------------------------------------------------

/**
 * Single-direction packet simulation from device `srcId` to `dstIp`.
 * Pure: does not mutate `state`. Returns the traversed `path` (device ids) plus,
 * on failure, a human-readable `reason`.
 */
export function simulatePacket(state: NetworkState, srcId: string, dstIp: string): SimResult {
  const src = getDevice(state, srcId);
  if (!src) return { success: false, path: [], reason: `unknown device "${srcId}"` };

  const path: string[] = [src.id];
  if (!src.powered) return { success: false, path, reason: `${src.label} is powered off` };

  const srcIface = src.interfaces.find((i) => i.ip && i.linkId);
  if (!srcIface?.ip || !srcIface.mask) {
    return { success: false, path, reason: `${src.label} has no IP configured` };
  }

  // Teaching rule #3: a sender must own a real host address.
  //
  // Nothing can source traffic from the network or broadcast address of its own
  // subnet — a real stack refuses to accept the config at all. Left unchecked,
  // the simulator happily carried packets for a host sitting on .0 or .255, so a
  // lab could pronounce a network "working" that no hardware would bring up.
  const srcRole = addressRole(srcIface.ip, srcIface.mask);
  if (srcRole === null) {
    return {
      success: false,
      path,
      reason: `${src.label} ${srcIface.name}: ${srcIface.ip} / ${srcIface.mask} is not a valid address and mask`,
    };
  }
  if (srcRole !== 'host') {
    return {
      success: false,
      path,
      reason:
        `${src.label} is configured with ${srcIface.ip}, the ${srcRole} address of its own ` +
        `subnet — no host can own that, so it cannot send`,
    };
  }

  // "Everyone on this wire". Belongs to no subnet, so it is decided before the
  // same-subnet test, and no router ever forwards it.
  if (dstIp === LIMITED_BROADCAST) {
    return l2Broadcast(state, src, srcIface, dstIp, path);
  }

  // Same subnet? Resolve at layer 2 across switches/hubs.
  if (sameSubnet(srcIface.ip, dstIp, srcIface.mask)) {
    const dstRole = addressRole(dstIp, srcIface.mask);
    // The subnet's broadcast address is a real destination — one frame, every
    // host on the segment — not a unicast to whoever happens to be mis-addressed.
    if (dstRole === 'broadcast') {
      return l2Broadcast(state, src, srcIface, dstIp, path);
    }
    if (dstRole === 'network') {
      return {
        success: false,
        path,
        reason: `${dstIp} names the network itself, not a host on it — nothing answers to it`,
      };
    }
    return l2Deliver(state, src, srcIface, dstIp, path);
  }

  // Different subnet -> must go via the default gateway.
  if (!src.gateway) {
    return {
      success: false,
      path,
      reason: `${src.label}: destination is remote and no default gateway is set`,
    };
  }

  const hop = l2Deliver(state, src, srcIface, src.gateway, path); // reach the gateway first
  if (!hop.success) {
    return { ...hop, reason: `cannot reach gateway ${src.gateway}: ${hop.reason}` };
  }

  // Route hop-by-hop across routers.
  let router: Device | undefined = deviceOwningIp(state, src.gateway);
  const seen = new Set<string>();
  while (router) {
    if (seen.has(router.id)) {
      return { success: false, path, reason: `routing loop at ${router.label}` };
    }
    seen.add(router.id);

    if (deviceOwnsSubnetFor(router, dstIp)) {
      // Destination network is directly connected to this router.
      const out = router.interfaces.find((i) => i.ip && i.mask && sameSubnet(i.ip, dstIp, i.mask))!;

      // The far end of a route can be a non-host address too. A directed
      // broadcast — one aimed at another subnet's broadcast address — stops
      // here: routers have dropped these by default since RFC 2644, and the
      // student should see the router refuse rather than watch it sail through.
      const dstRole = addressRole(dstIp, out.mask!);
      if (dstRole === 'broadcast') {
        return {
          success: false,
          path,
          reason:
            `${router.label} will not forward a directed broadcast to ${dstIp} — ` +
            `routers drop broadcasts aimed at another subnet`,
        };
      }
      if (dstRole === 'network') {
        return {
          success: false,
          path,
          reason: `${dstIp} names the network behind ${router.label}, not a host on it`,
        };
      }

      const fw = checkFirewall(router, out, dstIp);
      if (!fw.pass) {
        return { success: false, path, reason: `blocked by ${router.label} rule: ${fw.reason}` };
      }
      return l2Deliver(state, router, out, dstIp, path);
    }

    const route = (router.routes || []).find((r) => inNetwork(dstIp, r.dst, r.mask));
    if (!route) {
      return { success: false, path, reason: `${router.label} has no route to ${dstIp}` };
    }

    const fw = checkFirewall(router, undefined, dstIp);
    if (!fw.pass) {
      return { success: false, path, reason: `blocked by ${router.label} rule: ${fw.reason}` };
    }

    const next: Device | undefined = deviceOwningIp(state, route.gateway);
    if (!next) {
      return {
        success: false,
        path,
        reason: `${router.label}: next hop ${route.gateway} unreachable`,
      };
    }
    if (!next.powered) {
      return { success: false, path, reason: `next hop ${next.label} is powered off` };
    }
    path.push(next.id);
    router = next;
  }

  return { success: false, path, reason: `no path to ${dstIp}` };
}

/**
 * Bidirectional reachability, i.e. a real ICMP ping: the echo request must reach
 * the destination AND the echo reply must make it back. This is what the
 * `canPing` objective uses. Returns the forward `path`; on a return-path failure
 * the reason is prefixed so the learner knows the request arrived but the reply
 * could not return (classic "missing the mirror route" symptom).
 */
export function ping(state: NetworkState, fromId: string, toIp: string): SimResult {
  const forward = simulatePacket(state, fromId, toIp);
  if (!forward.success) return forward;

  const from = getDevice(state, fromId);
  const fromIface = from?.interfaces.find((i) => i.ip && i.linkId);

  // A broadcast is answered by whoever can answer, and one reply is enough for
  // the ping to have proved something. `recipients` narrows from "received it"
  // to "answered it", so a caller reporting replies never invents one.
  if (forward.broadcast) {
    if (!from || !fromIface?.ip) return forward;
    const sourceIp = fromIface.ip;
    const answered = (forward.recipients ?? []).filter(
      (id) => simulatePacket(state, id, sourceIp).success,
    );
    if (answered.length === 0) {
      return {
        ...forward,
        success: false,
        reason: `the broadcast was received, but no one on the segment could reply to ${sourceIp}`,
      };
    }
    return { ...forward, recipients: answered };
  }

  const dst = deviceOwningIp(state, toIp);
  if (!from || !fromIface?.ip || !dst) return forward; // nothing to reply to; forward stands

  const reverse = simulatePacket(state, dst.id, fromIface.ip);
  if (!reverse.success) {
    return {
      success: false,
      path: forward.path,
      reason: `request reached ${dst.label}, but the reply could not return: ${reverse.reason}`,
    };
  }
  return { success: true, path: forward.path };
}
