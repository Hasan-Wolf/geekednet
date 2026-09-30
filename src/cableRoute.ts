/**
 * Turning the engine's hop list into the devices a packet physically passes.
 *
 * `SimResult.path` is a layer-3 itinerary: the sender, each router it is routed
 * through, the destination. Switches and hubs are invisible at that layer, so
 * the engine never puts them in it (see `l2Deliver`) — a first-lab ping comes
 * back as `['pc1', 'pc2']` with no mention of the switch between them. Drawing
 * that list as a polyline flies the packet straight from PC to PC, past the
 * switch it really crosses: harmless-looking while the lab happens to lay those
 * three devices out in a line, and a lie the moment one is dragged.
 *
 * This module re-derives the real run of cables from `NetworkState.links`, so
 * the canvas can draw what actually happens. It is pure graph work over the
 * network the student can see — no lab, topology or device naming is assumed
 * anywhere in it, and it changes nothing about how the engine simulates.
 */
import type { Device, NetworkState } from '../engine/index.js';

/**
 * Devices that pass a frame along inside a segment.
 *
 * This mirrors the engine's own rule in `l2Deliver` — the same rule that keeps
 * them out of `SimResult.path` in the first place — so only these may sit in the
 * middle of a leg. Without the restriction a meshed lab could "expand" a
 * one-cable leg into a detour through a router the packet never entered. If the
 * engine ever teaches another kind to forward at layer 2, this set has to learn
 * it too.
 */
export const FORWARDS_L2: ReadonlySet<Device['kind']> = new Set<Device['kind']>(['switch', 'hub']);

/** Every device cabled directly to this one. */
export function neighbours(net: NetworkState, deviceId: string): string[] {
  const out: string[] = [];
  for (const link of net.links) {
    if (link.a.deviceId === deviceId) out.push(link.b.deviceId);
    else if (link.b.deviceId === deviceId) out.push(link.a.deviceId);
  }
  return out;
}

/**
 * Shortest run of cables between two devices, endpoints included, passing only
 * through devices `canTransit` allows. Breadth-first, so a meshed lab takes the
 * fewest hops. Null when the two aren't wired together under that restriction.
 */
export function shortestLeg(
  net: NetworkState,
  from: string,
  to: string,
  canTransit: (d: Device) => boolean,
): string[] | null {
  if (from === to) return [from];
  const prev = new Map<string, string>();
  const seen = new Set<string>([from]);
  const queue: string[] = [from];

  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const id of neighbours(net, cur)) {
      if (seen.has(id)) continue;
      seen.add(id);
      prev.set(id, cur);
      if (id === to) {
        const leg = [to];
        let step = to;
        while (step !== from) {
          step = prev.get(step)!;
          leg.unshift(step);
        }
        return leg;
      }
      const dev = net.devices.find((d) => d.id === id);
      if (dev && canTransit(dev)) queue.push(id);
    }
  }
  return null;
}

/**
 * Expand a hop list into every device the packet passes through, in order, by
 * walking the actual cabling between each consecutive pair.
 *
 * Nothing here knows what a lab looks like: PC → switch → PC, PC → router →
 * router → PC, a stack of switches, a branching segment — all of it falls out of
 * `net.links`. A leg that can't be walked at layer 2 falls back to any cable run
 * and finally to the bare pair, so an unusual topology degrades to a straight
 * line rather than losing the packet.
 */
export function cableRoute(net: NetworkState, hops: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < hops.length; i += 1) {
    if (i === 0) {
      out.push(hops[0]);
      continue;
    }
    const from = hops[i - 1];
    const to = hops[i];
    const leg =
      shortestLeg(net, from, to, (d) => FORWARDS_L2.has(d.kind)) ??
      shortestLeg(net, from, to, () => true) ?? [from, to];
    for (const id of leg.slice(1)) out.push(id); // the first is already on `out`
  }
  return out;
}

/**
 * Like {@link cableRoute}, but refuses to invent a leg.
 *
 * `cableRoute` falls back to a bare `[from, to]` pair so an odd topology
 * degrades to a straight line rather than losing the packet. For a fan-out that
 * fallback is exactly the wrong trade: a head sliding between two devices with
 * no cable between them draws a connection the student does not have. Here an
 * unwalkable leg returns null and the caller draws nothing instead.
 */
export function cableRouteStrict(net: NetworkState, hops: string[]): string[] | null {
  const out: string[] = [];
  for (let i = 0; i < hops.length; i += 1) {
    if (i === 0) {
      out.push(hops[0]);
      continue;
    }
    const leg =
      shortestLeg(net, hops[i - 1], hops[i], (d) => FORWARDS_L2.has(d.kind)) ??
      shortestLeg(net, hops[i - 1], hops[i], () => true);
    if (!leg) return null;
    for (const id of leg.slice(1)) out.push(id);
  }
  return out;
}

/**
 * Every cable run a packet travels, expanded device by device.
 *
 * A unicast is one run — the engine's hop list through the real cabling, exactly
 * as before. A broadcast is one run *per recipient*: the engine reports who
 * accepted the frame, and each of them gets its own route out of the sender,
 * which is what lets the canvas put a head on every branch at once.
 *
 * Nothing here knows a switch from a hub from a future device that floods: the
 * routes fall out of `net.links` and the recipients the engine named, so this
 * holds for any topology, any number of recipients and any lab.
 */
export function packetCableRoutes(
  net: NetworkState,
  path: string[],
  recipients?: readonly string[],
): string[][] {
  if (!recipients || recipients.length === 0) {
    return path.length > 0 ? [cableRoute(net, path)] : [];
  }

  const src = path[0];
  if (src === undefined) return [];

  // Deduplicated: the engine lists each recipient once, but a caller replaying a
  // stale result should still not get two heads racing down one cable.
  const seen = new Set<string>();
  const routes: string[][] = [];
  for (const id of recipients) {
    if (id === src || seen.has(id)) continue;
    seen.add(id);
    const run = cableRouteStrict(net, [src, id]);
    if (run && run.length > 1) routes.push(run);
  }
  return routes;
}

/**
 * Where a packet that failed came to a stop — the last device it actually
 * reached, so the canvas can mark the spot the student should be looking at.
 *
 * Undefined for a delivery that succeeded, and for one that never left the
 * sender: the banner already names that failure, and ringing the device whose
 * terminal you are typing into says nothing.
 */
export function blockedAt(path: string[], success: boolean): string | undefined {
  if (success || path.length < 2) return undefined;
  return path[path.length - 1];
}
