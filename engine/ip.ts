/**
 * IPv4 address math (Build Brief §7 helpers: `sameSubnet`, `inNetwork`).
 *
 * All functions are pure. Parsing is strict; `sameSubnet` / `inNetwork` swallow
 * parse errors and return `false` so a mis-typed address in device config surfaces
 * as "unreachable" rather than a thrown exception mid-simulation.
 */

/** Parse a dotted-quad IPv4 string into an unsigned 32-bit integer. Throws on bad input. */
export function ipToInt(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) throw new Error(`invalid IPv4 address: ${ip}`);
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) throw new Error(`invalid IPv4 address: ${ip}`);
    const octet = Number(part);
    if (octet < 0 || octet > 255) throw new Error(`invalid IPv4 address: ${ip}`);
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** Format an unsigned 32-bit integer back into a dotted-quad string. */
export function intToIp(value: number): string {
  const v = value >>> 0;
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff].join('.');
}

/** Count the leading 1-bits of a subnet mask (e.g. 255.255.255.0 -> 24). */
export function maskToPrefix(mask: string): number {
  const m = ipToInt(mask);
  let prefix = 0;
  let seenZero = false;
  for (let bit = 31; bit >= 0; bit--) {
    const isSet = (m & (1 << bit)) !== 0;
    if (isSet) {
      if (seenZero) throw new Error(`non-contiguous subnet mask: ${mask}`);
      prefix++;
    } else {
      seenZero = true;
    }
  }
  return prefix;
}

/**
 * Do two addresses fall in the same subnet under `mask`?
 * Returns `false` (never throws) if any argument fails to parse.
 */
export function sameSubnet(a: string, b: string, mask: string): boolean {
  try {
    const m = ipToInt(mask);
    const netA = (ipToInt(a) & m) >>> 0;
    const netB = (ipToInt(b) & m) >>> 0;
    return netA === netB;
  } catch {
    return false;
  }
}

/**
 * Is `ip` inside the network `network`/`mask`? Semantically identical to
 * {@link sameSubnet} but reads as "does this route/network contain this address".
 * Returns `false` (never throws) on parse failure.
 */
export function inNetwork(ip: string, network: string, mask: string): boolean {
  return sameSubnet(ip, network, mask);
}
/**
 * The limited broadcast address — "everyone on this wire".
 *
 * It belongs to no subnet and a router never forwards it, so it is handled apart
 * from the per-subnet broadcast address {@link addressRole} classifies.
 */
export const LIMITED_BROADCAST = '255.255.255.255';

/** What an address is, within the subnet its own mask puts it in. */
export type AddressRole = 'host' | 'network' | 'broadcast';

/**
 * Classify `ip` inside the subnet it sits in under `mask`: a usable host, the
 * network address (all-zero host part) or the broadcast address (all-ones).
 *
 * A /31 and a /32 reserve neither (a /31 is a two-address point-to-point link
 * per RFC 3021, a /32 a single host), so every address in them is a host.
 * Returns `null` (never throws) if either argument fails to parse — the same
 * "surface it as a failed delivery, not an exception mid-simulation" contract
 * as {@link inNetwork}.
 */
export function addressRole(ip: string, mask: string): AddressRole | null {
  try {
    if (maskToPrefix(mask) >= 31) return 'host';
    const m = ipToInt(mask);
    const addr = ipToInt(ip);
    const network = (addr & m) >>> 0;
    const broadcast = (network | (~m >>> 0)) >>> 0;
    if (addr === network) return 'network';
    if (addr === broadcast) return 'broadcast';
    return 'host';
  } catch {
    return null;
  }
}

/**
 * Is `ip` a usable host address in the subnet `ip`/`mask` — that is, neither the
 * network address nor the broadcast address?
 *
 * "Any address on 192.168.1.0/24" is not quite what a lab means when it lets a
 * student choose: .0 names the network itself and .255 is the broadcast address,
 * and a host configured with either is broken. Both the objective that accepts a
 * student's address and the simulator that moves their packets go through here,
 * so the two cannot disagree about what counts as a host.
 *
 * Returns `false` (never throws) on parse failure, matching {@link inNetwork}.
 */
export function isHostAddress(ip: string, mask: string): boolean {
  return addressRole(ip, mask) === 'host';
}

/**
 * Where the search for a free host address starts.
 *
 * `ifaceInNetwork` lets the student pick any host address, so anything deriving
 * a solution has to pick one too — and .1 through .9 are where a reader expects
 * routers and gateways, not a PC. Starting at .10 lands on the addresses the
 * labs' own hints reach for ("say 192.168.1.10"), and the low addresses are
 * still tried afterwards so a subnet too small to have a tenth address is not a
 * dead end.
 */
const PREFERRED_FIRST_HOST = 10;

/**
 * Ceiling on how many addresses are examined in one subnet. A /8 has sixteen
 * million and the answer is always in the first handful.
 */
const MAX_SCAN = 1024;

/**
 * First usable host address in `network`/`mask` that nothing in `taken` holds.
 *
 * "Usable" is {@link isHostAddress}'s definition — not the network address, not
 * the broadcast address — so the address this picks is one an `ifaceInNetwork`
 * objective will actually accept. Returns `undefined` if the subnet is full or
 * either argument fails to parse, matching the rest of this module's "surface it
 * as a failure, not an exception" contract: the caller leaves the interface
 * alone rather than writing a malformed address.
 *
 * Shared ground for the two things that need to answer "what would a finished
 * lab look like": the phone view's `solveLab`, which shows the end state, and
 * {@link ../replayGenerator.ts}, which shows the path to it. Two copies of this
 * preference order would mean a generated walkthrough handing out a different
 * address than the solved view it is a walkthrough of.
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
    return undefined;
  }
  const preferred: number[] = [];
  const low: number[] = [];
  for (let offset = 0; offset < size; offset += 1) {
    (offset >= PREFERRED_FIRST_HOST ? preferred : low).push(offset);
  }
  for (const offset of [...preferred, ...low]) {
    const candidate = intToIp((base + offset) >>> 0);
    if (!isHostAddress(candidate, mask)) continue;
    if (taken.has(candidate)) continue;
    return candidate;
  }
  return undefined;
}
