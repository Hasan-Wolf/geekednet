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
