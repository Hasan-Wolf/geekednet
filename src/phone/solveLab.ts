/**
 * A lab as it looks once someone has finished it — derived from the lab's own
 * objectives.
 *
 * A lab's `initialState` is deliberately broken: an unaddressed PC, a wrong
 * mask, a router with an empty routing table. That is the lesson, and on a phone
 * there is nothing to fix it with — no dragging, no cabling, no editing. So the
 * phone shows the finished article instead: the lab's own topology, already
 * built and already addressed, with a packet you can send across it.
 *
 * Nothing here is authored a second time. The topology *is* the lab's
 * `initialState` — same devices, same ids, same coordinates, same cables — and
 * the configuration is read back out of the lab's own {@link Objective} checks:
 * `ifaceHasIp` says which address an interface must carry, `ifaceInNetwork` says
 * which network it must sit on, `hasRoute` names a route a router is missing.
 * So a fourth lab arrives solved for free, exactly the way it arrives playable
 * for free, and `phone.test.ts` holds every registered lab to the engine's own
 * `isLabComplete` so a lab whose objectives don't fully describe its solution
 * fails loudly at test time rather than shipping a phone view that can't ping.
 *
 * Pure, and pure over the lab: the input is never mutated (§ engine contract —
 * a lab's `initialState` is shared by every session that loads it).
 */
import {
  inNetwork,
  intToIp,
  ipToInt,
  isHostAddress,
  maskToPrefix,
  type Device,
  type Interface,
  type Lab,
  type NetworkState,
  type Predicate,
} from '../../engine/index.js';

/**
 * Where the search for a free host address starts.
 *
 * `ifaceInNetwork` lets the student pick any host address, so the solver has to
 * pick one too — and .1 through .9 are where a reader expects to find routers
 * and gateways, not a PC. Starting at .10 lands on the addresses the labs' own
 * hints reach for ("say 192.168.1.10"), and the low addresses are still tried
 * afterwards so a subnet too small to have a tenth address is not a dead end.
 */
const PREFERRED_FIRST_HOST = 10;

/** Ceiling on how many addresses are examined in one subnet. A /8 has sixteen
 *  million and the answer is always in the first handful. */
const MAX_SCAN = 1024;

/** Every address currently configured anywhere in the network. */
function addressesInUse(net: NetworkState): Set<string> {
  const out = new Set<string>();
  for (const device of net.devices) {
    for (const iface of device.interfaces) {
      if (iface.ip) out.add(iface.ip);
    }
  }
  return out;
}

/**
 * Offsets into a subnet, in the order they should be tried: the tenth address
 * onward first, then the low ones. See {@link PREFERRED_FIRST_HOST}.
 */
function hostOffsets(size: number): number[] {
  const preferred: number[] = [];
  const low: number[] = [];
  for (let i = 0; i < size; i += 1) {
    (i >= PREFERRED_FIRST_HOST ? preferred : low).push(i);
  }
  return [...preferred, ...low];
}

/**
 * First usable host address in `network`/`mask` that nothing has taken.
 *
 * "Usable" is the engine's own definition (`isHostAddress`) — not the network
 * address, not the broadcast address — so the address this picks is an address
 * the objective will actually accept. Undefined if the subnet is full or either
 * argument doesn't parse.
 */
export function pickHostAddress(
  network: string,
  mask: string,
  taken: ReadonlySet<string>,
): string | undefined {
  let base: number;
  let size: number;
  try {
    base = (ipToInt(network) & ipToInt(mask)) >>> 0;
    size = Math.min(2 ** (32 - maskToPrefix(mask)), MAX_SCAN);
  } catch {
    return undefined; // a malformed objective; the caller leaves the iface alone
  }
  for (const offset of hostOffsets(size)) {
    const candidate = intToIp((base + offset) >>> 0);
    if (!isHostAddress(candidate, mask)) continue;
    if (taken.has(candidate)) continue;
    return candidate;
  }
  return undefined;
}

function findIface(
  net: NetworkState,
  deviceId: string,
  ifaceId: string,
): Interface | undefined {
  const device: Device | undefined = net.devices.find((d) => d.id === deviceId);
  return device?.interfaces.find((i) => i.id === ifaceId);
}

/** Does this interface already satisfy an `ifaceInNetwork` check? */
function alreadyInNetwork(
  net: NetworkState,
  iface: Interface,
  network: string,
  mask: string,
): boolean {
  if (!iface.ip || iface.mask !== mask) return false;
  if (!inNetwork(iface.ip, network, mask)) return false;
  if (!isHostAddress(iface.ip, mask)) return false;
  // The engine counts two interfaces on one address as a conflict, not as two
  // solved objectives — so an address shared with someone else is not "already
  // configured", it is the thing being fixed.
  const others = net.devices
    .flatMap((d) => d.interfaces)
    .filter((i) => i !== iface && i.ip === iface.ip);
  return others.length === 0;
}

/**
 * Apply whatever one objective's predicate asks for to the working network.
 *
 * `canPing` is the outcome of the others rather than a thing to configure, and
 * `commandRun` / `answerEquals` are about what the student typed, not about the
 * network — all three are deliberate no-ops.
 */
function applyCheck(net: NetworkState, check: Predicate): void {
  switch (check.type) {
    case 'ifaceHasIp': {
      const iface = findIface(net, check.device, check.iface);
      if (!iface) return;
      iface.ip = check.ip;
      // A check that names no mask is not asking for one; leave what is there.
      if (check.mask !== undefined) iface.mask = check.mask;
      return;
    }

    case 'ifaceInNetwork': {
      const iface = findIface(net, check.device, check.iface);
      if (!iface) return;
      if (alreadyInNetwork(net, iface, check.network, check.mask)) return;
      const taken = addressesInUse(net);
      // The interface's own address is not "taken" from its own point of view —
      // it is about to be replaced.
      if (iface.ip) taken.delete(iface.ip);
      const ip = pickHostAddress(check.network, check.mask, taken);
      if (!ip) return; // nothing free to hand out; leave the lab as authored
      iface.ip = ip;
      iface.mask = check.mask;
      return;
    }

    case 'hasRoute': {
      const device = net.devices.find((d) => d.id === check.device);
      if (!device) return;
      if (!device.routes) device.routes = [];
      const already = device.routes.some(
        (r) => r.dst === check.dst && r.mask === check.mask && r.gateway === check.gateway,
      );
      if (!already) {
        device.routes.push({ dst: check.dst, mask: check.mask, gateway: check.gateway });
      }
      return;
    }

    default:
      return;
  }
}

/**
 * The lab's network with every objective already satisfied.
 *
 * Objectives are applied in the order the lab declares them, which is the order
 * a student would work through them — and it matters for the labs that let the
 * student choose: two interfaces told to sit on one /24 get two different
 * addresses because the second pick sees what the first one took.
 */
export function solveLab(lab: Lab): NetworkState {
  const net: NetworkState = structuredClone(lab.initialState);
  for (const objective of lab.objectives) {
    applyCheck(net, objective.check);
  }
  return net;
}
