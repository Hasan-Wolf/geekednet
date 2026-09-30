import { describe, it, expect } from 'vitest';
import {
  addressRole,
  inNetwork,
  intToIp,
  ipToInt,
  isHostAddress,
  maskToPrefix,
  sameSubnet,
} from '../ip.js';

describe('ipToInt / intToIp', () => {
  it('parses and formats round-trip', () => {
    expect(ipToInt('0.0.0.0')).toBe(0);
    expect(ipToInt('255.255.255.255')).toBe(0xffffffff);
    expect(ipToInt('192.168.1.10')).toBe(0xc0a8010a);
    expect(intToIp(0xc0a8010a)).toBe('192.168.1.10');
    expect(intToIp(ipToInt('10.0.0.1'))).toBe('10.0.0.1');
  });

  it('returns an unsigned value for high addresses', () => {
    expect(ipToInt('255.255.255.255')).toBeGreaterThan(0);
  });

  it('rejects malformed input', () => {
    expect(() => ipToInt('192.168.1')).toThrow();
    expect(() => ipToInt('192.168.1.256')).toThrow();
    expect(() => ipToInt('192.168.1.1.1')).toThrow();
    expect(() => ipToInt('abc')).toThrow();
    expect(() => ipToInt('192.168.-1.1')).toThrow();
  });
});

describe('maskToPrefix', () => {
  it('counts leading ones', () => {
    expect(maskToPrefix('255.255.255.0')).toBe(24);
    expect(maskToPrefix('255.255.255.128')).toBe(25);
    expect(maskToPrefix('255.255.255.252')).toBe(30);
    expect(maskToPrefix('0.0.0.0')).toBe(0);
    expect(maskToPrefix('255.255.255.255')).toBe(32);
  });

  it('rejects non-contiguous masks', () => {
    expect(() => maskToPrefix('255.0.255.0')).toThrow();
  });
});

describe('sameSubnet', () => {
  it('is true within a /24', () => {
    expect(sameSubnet('192.168.1.10', '192.168.1.11', '255.255.255.0')).toBe(true);
    expect(sameSubnet('192.168.1.10', '192.168.2.11', '255.255.255.0')).toBe(false);
  });

  it('splits a /25 at the boundary', () => {
    expect(sameSubnet('192.168.1.10', '192.168.1.11', '255.255.255.128')).toBe(true); // both < 128
    expect(sameSubnet('192.168.1.10', '192.168.1.200', '255.255.255.128')).toBe(false);
  });

  it('never throws on bad input — returns false', () => {
    expect(sameSubnet('nope', '192.168.1.1', '255.255.255.0')).toBe(false);
    expect(sameSubnet('192.168.1.1', '192.168.1.2', 'bad-mask')).toBe(false);
  });
});

describe('inNetwork', () => {
  it('matches an address to its network/mask', () => {
    expect(inNetwork('20.0.0.10', '20.0.0.0', '255.255.255.0')).toBe(true);
    expect(inNetwork('20.0.1.10', '20.0.0.0', '255.255.255.0')).toBe(false);
    expect(inNetwork('172.16.0.2', '172.16.0.0', '255.255.255.252')).toBe(true);
  });
});

describe('isHostAddress', () => {
  it('accepts the usable addresses of a /24 and rejects the two that are not', () => {
    expect(isHostAddress('192.168.1.1', '255.255.255.0')).toBe(true);
    expect(isHostAddress('192.168.1.254', '255.255.255.0')).toBe(true);
    expect(isHostAddress('192.168.1.0', '255.255.255.0')).toBe(false); // the network
    expect(isHostAddress('192.168.1.255', '255.255.255.0')).toBe(false); // broadcast
  });

  it('finds the boundary of the subnet the address is actually in', () => {
    // On a /25, .127 is the broadcast of the lower half and .128 names the upper.
    expect(isHostAddress('192.168.1.127', '255.255.255.128')).toBe(false);
    expect(isHostAddress('192.168.1.128', '255.255.255.128')).toBe(false);
    expect(isHostAddress('192.168.1.126', '255.255.255.128')).toBe(true);
    expect(isHostAddress('192.168.1.255', '255.255.255.128')).toBe(false);
    // A /30 backbone link: two hosts between the network and broadcast address.
    expect(isHostAddress('172.16.0.1', '255.255.255.252')).toBe(true);
    expect(isHostAddress('172.16.0.2', '255.255.255.252')).toBe(true);
    expect(isHostAddress('172.16.0.0', '255.255.255.252')).toBe(false);
    expect(isHostAddress('172.16.0.3', '255.255.255.252')).toBe(false);
  });

  it('reserves nothing on a /31 or /32', () => {
    // RFC 3021 point-to-point link — both addresses are usable.
    expect(isHostAddress('10.0.0.0', '255.255.255.254')).toBe(true);
    expect(isHostAddress('10.0.0.1', '255.255.255.254')).toBe(true);
    expect(isHostAddress('10.0.0.7', '255.255.255.255')).toBe(true);
  });

  it('never throws on bad input — returns false', () => {
    expect(isHostAddress('nope', '255.255.255.0')).toBe(false);
    expect(isHostAddress('192.168.1.10', '255.0.255.0')).toBe(false);
  });
});

describe('addressRole', () => {
  it('names which of the three an address is', () => {
    expect(addressRole('192.168.1.0', '255.255.255.0')).toBe('network');
    expect(addressRole('192.168.1.255', '255.255.255.0')).toBe('broadcast');
    expect(addressRole('192.168.1.42', '255.255.255.0')).toBe('host');
  });

  it('answers for the subnet the mask actually carves out', () => {
    // The same address is a host, a network or a broadcast depending on the mask.
    expect(addressRole('192.168.1.128', '255.255.255.0')).toBe('host');
    expect(addressRole('192.168.1.128', '255.255.255.128')).toBe('network');
    expect(addressRole('192.168.1.127', '255.255.255.128')).toBe('broadcast');
    expect(addressRole('172.16.0.3', '255.255.255.252')).toBe('broadcast');
    expect(addressRole('172.16.0.0', '255.255.255.252')).toBe('network');
  });

  it('reserves nothing on a /31 or /32', () => {
    expect(addressRole('10.0.0.0', '255.255.255.254')).toBe('host');
    expect(addressRole('10.0.0.1', '255.255.255.254')).toBe('host');
    expect(addressRole('10.0.0.7', '255.255.255.255')).toBe('host');
  });

  it('returns null rather than throwing on input it cannot parse', () => {
    expect(addressRole('nope', '255.255.255.0')).toBeNull();
    expect(addressRole('192.168.1.1', '255.0.255.0')).toBeNull();
  });

  it('is the one source of truth isHostAddress reads from', () => {
    for (const [ip, mask] of [
      ['192.168.1.0', '255.255.255.0'],
      ['192.168.1.255', '255.255.255.0'],
      ['192.168.1.42', '255.255.255.0'],
      ['10.0.0.0', '255.255.255.254'],
      ['bad', 'worse'],
    ]) {
      expect(isHostAddress(ip, mask), `${ip} / ${mask}`).toBe(addressRole(ip, mask) === 'host');
    }
  });
});
