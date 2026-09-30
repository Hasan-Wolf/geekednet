import { describe, it, expect } from 'vitest';
import type { Device, NetworkState } from '../types.js';
import {
  simulatePacket,
  ping,
  l2Deliver,
  deviceOwningIp,
  deviceOwnsSubnetFor,
  checkFirewall,
} from '../simulate.js';

// --- Small hand-built topologies (independent of the mission JSON) ---------

/** PC1 -- Switch -- PC2, both on 192.168.1.0/24 by default. */
function twoPcsOneSwitch(overrides?: {
  pc1Ip?: string | null;
  pc1Mask?: string | null;
  pc2Ip?: string | null;
  pc2Mask?: string | null;
  pc1Powered?: boolean;
  pc2Powered?: boolean;
}): NetworkState {
  const o = overrides ?? {};
  // Honor an explicit `null` override (use `in`, not `??`, so null isn't defaulted).
  const pick = <T>(key: keyof typeof o, fallback: T): T =>
    key in o ? (o[key] as T) : fallback;
  return {
    devices: [
      {
        id: 'pc1',
        kind: 'pc',
        label: 'PC1',
        powered: pick('pc1Powered', true),
        x: 0,
        y: 0,
        interfaces: [
          {
            id: 'e0',
            name: 'eth0',
            ip: pick('pc1Ip', '192.168.1.10' as string | null),
            mask: pick('pc1Mask', '255.255.255.0' as string | null),
            linkId: 'l1',
          },
        ],
      },
      {
        id: 'pc2',
        kind: 'pc',
        label: 'PC2',
        powered: pick('pc2Powered', true),
        x: 0,
        y: 0,
        interfaces: [
          {
            id: 'e0',
            name: 'eth0',
            ip: pick('pc2Ip', '192.168.1.11' as string | null),
            mask: pick('pc2Mask', '255.255.255.0' as string | null),
            linkId: 'l2',
          },
        ],
      },
      {
        id: 'sw',
        kind: 'switch',
        label: 'Switch',
        powered: true,
        x: 0,
        y: 0,
        interfaces: [
          { id: 'p1', name: 'port1', linkId: 'l1' },
          { id: 'p2', name: 'port2', linkId: 'l2' },
        ],
      },
    ],
    links: [
      { id: 'l1', a: { deviceId: 'pc1', ifaceId: 'e0' }, b: { deviceId: 'sw', ifaceId: 'p1' } },
      { id: 'l2', a: { deviceId: 'pc2', ifaceId: 'e0' }, b: { deviceId: 'sw', ifaceId: 'p2' } },
    ],
  };
}

describe('lookups', () => {
  const state = twoPcsOneSwitch();

  it('deviceOwningIp finds the interface holder', () => {
    expect(deviceOwningIp(state, '192.168.1.10')?.id).toBe('pc1');
    expect(deviceOwningIp(state, '192.168.1.99')).toBeUndefined();
  });

  it('deviceOwnsSubnetFor recognises a directly-connected subnet', () => {
    const pc1 = state.devices.find((d) => d.id === 'pc1')!;
    expect(deviceOwnsSubnetFor(pc1, '192.168.1.200')).toBe(true);
    expect(deviceOwnsSubnetFor(pc1, '10.0.0.1')).toBe(false);
  });
});

describe('simulatePacket — same subnet via a switch', () => {
  it('succeeds and reports the L2 path pc1 -> pc2', () => {
    const res = simulatePacket(twoPcsOneSwitch(), 'pc1', '192.168.1.11');
    expect(res.success).toBe(true);
    expect(res.path).toEqual(['pc1', 'pc2']);
  });

  it('fails with a reason when the source has no IP', () => {
    const res = simulatePacket(twoPcsOneSwitch({ pc1Ip: null, pc1Mask: null }), 'pc1', '192.168.1.11');
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/no IP configured/i);
  });

  it('fails when the source is powered off', () => {
    const res = simulatePacket(twoPcsOneSwitch({ pc1Powered: false }), 'pc1', '192.168.1.11');
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/powered off/i);
  });

  it('fails when the destination is powered off', () => {
    const res = simulatePacket(twoPcsOneSwitch({ pc2Powered: false }), 'pc1', '192.168.1.11');
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/powered off/i);
  });

  it('fails for an unknown source device', () => {
    const res = simulatePacket(twoPcsOneSwitch(), 'ghost', '192.168.1.11');
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/unknown device/i);
  });

  it('fails when no device owns the destination IP', () => {
    const res = simulatePacket(twoPcsOneSwitch(), 'pc1', '192.168.1.250');
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/owns 192\.168\.1\.250/i);
  });
});

describe('simulatePacket — mask mismatch (teaching rule #1)', () => {
  it('one-way delivery fails when the two hosts disagree on the mask', () => {
    // Both .10 and .11 are in the lower half, so /24 vs /25 agree mathematically —
    // only the mask-equality rule makes this fail, which is the lab's whole point.
    const res = simulatePacket(
      twoPcsOneSwitch({ pc2Mask: '255.255.255.128' }),
      'pc1',
      '192.168.1.11',
    );
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/subnet masks differ/i);
  });

  it('succeeds once the masks match', () => {
    const res = simulatePacket(
      twoPcsOneSwitch({ pc2Mask: '255.255.255.0' }),
      'pc1',
      '192.168.1.11',
    );
    expect(res.success).toBe(true);
  });
});

describe('ping — bidirectional', () => {
  it('succeeds both ways on a healthy segment', () => {
    expect(ping(twoPcsOneSwitch(), 'pc1', '192.168.1.11').success).toBe(true);
  });

  it('fails if the mask mismatch breaks the request', () => {
    expect(ping(twoPcsOneSwitch({ pc2Mask: '255.255.255.128' }), 'pc1', '192.168.1.11').success).toBe(
      false,
    );
  });
});

describe('l2Deliver — hub floods but still delivers', () => {
  it('delivers across a hub', () => {
    const state = twoPcsOneSwitch();
    const hub = state.devices.find((d) => d.id === 'sw')!;
    hub.kind = 'hub';
    hub.label = 'Hub';
    const res = simulatePacket(state, 'pc1', '192.168.1.11');
    expect(res.success).toBe(true);
    expect(res.path).toEqual(['pc1', 'pc2']);
  });

  it('reports a cabling fault when the far port is not linked', () => {
    const state = twoPcsOneSwitch();
    // Disconnect pc2 from the switch.
    state.links = state.links.filter((l) => l.id !== 'l2');
    const pc2 = state.devices.find((d) => d.id === 'pc2')!;
    pc2.interfaces[0].linkId = null;
    const res = l2Deliver(
      state,
      state.devices.find((d) => d.id === 'pc1')!,
      state.devices.find((d) => d.id === 'pc1')!.interfaces[0],
      '192.168.1.11',
      ['pc1'],
    );
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/unreachable at layer 2/i);
  });
});

// --- A routed topology for gateway / route behaviour -----------------------

/** PC-A -- R1 == R2 -- PC-B, two /24 LANs joined by a /30 backbone. */
function twoRouterState(): NetworkState {
  return {
    devices: [
      {
        id: 'pcA',
        kind: 'pc',
        label: 'PC-A',
        powered: true,
        x: 0,
        y: 0,
        gateway: '10.0.0.1',
        interfaces: [{ id: 'e0', name: 'eth0', ip: '10.0.0.10', mask: '255.255.255.0', linkId: 'la' }],
      },
      {
        id: 'r1',
        kind: 'router',
        label: 'R1',
        powered: true,
        x: 0,
        y: 0,
        routes: [],
        interfaces: [
          { id: 'g0', name: 'ether1', ip: '10.0.0.1', mask: '255.255.255.0', linkId: 'la' },
          { id: 'g1', name: 'ether2', ip: '172.16.0.1', mask: '255.255.255.252', linkId: 'bb' },
        ],
      },
      {
        id: 'r2',
        kind: 'router',
        label: 'R2',
        powered: true,
        x: 0,
        y: 0,
        routes: [],
        interfaces: [
          { id: 'g0', name: 'ether1', ip: '20.0.0.1', mask: '255.255.255.0', linkId: 'lb' },
          { id: 'g1', name: 'ether2', ip: '172.16.0.2', mask: '255.255.255.252', linkId: 'bb' },
        ],
      },
      {
        id: 'pcB',
        kind: 'pc',
        label: 'PC-B',
        powered: true,
        x: 0,
        y: 0,
        gateway: '20.0.0.1',
        interfaces: [{ id: 'e0', name: 'eth0', ip: '20.0.0.10', mask: '255.255.255.0', linkId: 'lb' }],
      },
    ],
    links: [
      { id: 'la', a: { deviceId: 'pcA', ifaceId: 'e0' }, b: { deviceId: 'r1', ifaceId: 'g0' } },
      { id: 'bb', a: { deviceId: 'r1', ifaceId: 'g1' }, b: { deviceId: 'r2', ifaceId: 'g1' } },
      { id: 'lb', a: { deviceId: 'r2', ifaceId: 'g0' }, b: { deviceId: 'pcB', ifaceId: 'e0' } },
    ],
  };
}

function addRoute(state: NetworkState, deviceId: string, dst: string, mask: string, gateway: string) {
  const dev = state.devices.find((d) => d.id === deviceId) as Device;
  dev.routes = dev.routes ?? [];
  dev.routes.push({ dst, mask, gateway });
}

describe('simulatePacket — routing across routers', () => {
  it('fails without a default gateway when the destination is remote', () => {
    const state = twoRouterState();
    delete state.devices.find((d) => d.id === 'pcA')!.gateway;
    const res = simulatePacket(state, 'pcA', '20.0.0.10');
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/no default gateway/i);
  });

  it('forward path only needs the near router route (far net is directly connected)', () => {
    const state = twoRouterState();
    addRoute(state, 'r1', '20.0.0.0', '255.255.255.0', '172.16.0.2');
    const res = simulatePacket(state, 'pcA', '20.0.0.10');
    expect(res.success).toBe(true);
    expect(res.path).toEqual(['pcA', 'r1', 'r2', 'pcB']);
  });

  it('reports the router that is missing a route', () => {
    const res = simulatePacket(twoRouterState(), 'pcA', '20.0.0.10');
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/R1 has no route to 20\.0\.0\.10/i);
  });

  it('ping needs BOTH static routes (reply path uses the far router route)', () => {
    const state = twoRouterState();
    addRoute(state, 'r1', '20.0.0.0', '255.255.255.0', '172.16.0.2');
    // Only the forward route so far: the request arrives, the reply cannot return.
    const oneWay = ping(state, 'pcA', '20.0.0.10');
    expect(oneWay.success).toBe(false);
    expect(oneWay.reason).toMatch(/reply could not return/i);
    expect(oneWay.reason).toMatch(/R2 has no route to 10\.0\.0\.10/i);

    addRoute(state, 'r2', '10.0.0.0', '255.255.255.0', '172.16.0.1');
    expect(ping(state, 'pcA', '20.0.0.10').success).toBe(true);
  });
});

// --- Mask-agreement rule is host-to-host ONLY ------------------------------

/**
 * One segment (switch) carrying a mis-masked host (pcBad, /25), a correctly
 * masked peer host (pcGood, /24), and a router gateway (/24). A remote server
 * sits behind the router. Used to prove the mask rule blocks host<->host but
 * never host<->gateway.
 */
function mismatchedHostSegment(): NetworkState {
  return {
    devices: [
      {
        id: 'pcBad',
        kind: 'pc',
        label: 'PC-Bad',
        powered: true,
        x: 0,
        y: 0,
        gateway: '10.0.0.1',
        interfaces: [{ id: 'e0', name: 'eth0', ip: '10.0.0.10', mask: '255.255.255.128', linkId: 'l1' }],
      },
      {
        id: 'pcGood',
        kind: 'pc',
        label: 'PC-Good',
        powered: true,
        x: 0,
        y: 0,
        gateway: '10.0.0.1',
        interfaces: [{ id: 'e0', name: 'eth0', ip: '10.0.0.20', mask: '255.255.255.0', linkId: 'l2' }],
      },
      {
        id: 'sw',
        kind: 'switch',
        label: 'Switch',
        powered: true,
        x: 0,
        y: 0,
        interfaces: [
          { id: 'p1', name: 'port1', linkId: 'l1' },
          { id: 'p2', name: 'port2', linkId: 'l2' },
          { id: 'p3', name: 'port3', linkId: 'l3' },
        ],
      },
      {
        id: 'r1',
        kind: 'router',
        label: 'R1',
        powered: true,
        x: 0,
        y: 0,
        routes: [],
        interfaces: [
          { id: 'g0', name: 'ether1', ip: '10.0.0.1', mask: '255.255.255.0', linkId: 'l3' },
          { id: 'g1', name: 'ether2', ip: '192.168.9.1', mask: '255.255.255.0', linkId: 'lr' },
        ],
      },
      {
        id: 'srv',
        kind: 'server',
        label: 'Server',
        powered: true,
        x: 0,
        y: 0,
        gateway: '192.168.9.1',
        interfaces: [{ id: 'e0', name: 'eth0', ip: '192.168.9.9', mask: '255.255.255.0', linkId: 'lr' }],
      },
    ],
    links: [
      { id: 'l1', a: { deviceId: 'pcBad', ifaceId: 'e0' }, b: { deviceId: 'sw', ifaceId: 'p1' } },
      { id: 'l2', a: { deviceId: 'pcGood', ifaceId: 'e0' }, b: { deviceId: 'sw', ifaceId: 'p2' } },
      { id: 'l3', a: { deviceId: 'sw', ifaceId: 'p3' }, b: { deviceId: 'r1', ifaceId: 'g0' } },
      { id: 'lr', a: { deviceId: 'r1', ifaceId: 'g1' }, b: { deviceId: 'srv', ifaceId: 'e0' } },
    ],
  };
}

describe('mask-agreement rule is host-to-host only', () => {
  it('a mis-masked host can still reach its gateway (host <-> router is exempt)', () => {
    const res = simulatePacket(mismatchedHostSegment(), 'pcBad', '10.0.0.1');
    expect(res.success).toBe(true);
    expect(res.path).toEqual(['pcBad', 'r1']);
  });

  it('and can route through that gateway to a remote host end-to-end', () => {
    expect(ping(mismatchedHostSegment(), 'pcBad', '192.168.9.9').success).toBe(true);
  });

  it('but cannot reach a same-segment host with a different mask', () => {
    const res = simulatePacket(mismatchedHostSegment(), 'pcBad', '10.0.0.20');
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/subnet masks differ/i);
  });

  it('the peer host becomes reachable once the masks match', () => {
    const state = mismatchedHostSegment();
    state.devices.find((d) => d.id === 'pcBad')!.interfaces[0].mask = '255.255.255.0';
    expect(simulatePacket(state, 'pcBad', '10.0.0.20').success).toBe(true);
  });
});

describe('checkFirewall', () => {
  const router: Device = {
    id: 'fw',
    kind: 'firewall',
    label: 'FW',
    powered: true,
    x: 0,
    y: 0,
    zone: 'wan',
    interfaces: [],
  };

  it('passes when there are no rules', () => {
    expect(checkFirewall(router, undefined, '1.1.1.1').pass).toBe(true);
  });

  it('blocks on a matching block rule', () => {
    const withRule: Device = { ...router, firewall: [{ action: 'block', proto: 'icmp' }] };
    const res = checkFirewall(withRule, undefined, '1.1.1.1', 'icmp');
    expect(res.pass).toBe(false);
    expect(res.reason).toMatch(/denied/i);
  });

  it('first matching rule wins (pass before block)', () => {
    const withRules: Device = {
      ...router,
      firewall: [
        { action: 'pass', proto: 'icmp' },
        { action: 'block', proto: 'icmp' },
      ],
    };
    expect(checkFirewall(withRules, undefined, '1.1.1.1', 'icmp').pass).toBe(true);
  });

  it('ignores rules for a different protocol', () => {
    const withRule: Device = { ...router, firewall: [{ action: 'block', proto: 'tcp' }] };
    expect(checkFirewall(withRule, undefined, '1.1.1.1', 'icmp').pass).toBe(true);
  });
});

// --- Non-host addresses: .0, .255 and the limited broadcast ----------------
//
// Nothing below names a lab or a particular subnet shape on purpose: the rule is
// what this mask makes of this address, so the same tests run over a /24, a /29
// and a /31.

/** PC1 -- Switch -- PC2, plus a third host on the same segment. */
function threeHostSegment(): NetworkState {
  const state = twoPcsOneSwitch();
  state.devices.push({
    id: 'pc3',
    kind: 'pc',
    label: 'PC3',
    powered: true,
    x: 0,
    y: 0,
    interfaces: [
      { id: 'e0', name: 'eth0', ip: '192.168.1.12', mask: '255.255.255.0', linkId: 'l3' },
    ],
  });
  const sw = state.devices.find((d) => d.id === 'sw')!;
  sw.interfaces.push({ id: 'p3', name: 'port3', linkId: 'l3' });
  state.links.push({
    id: 'l3',
    a: { deviceId: 'pc3', ifaceId: 'e0' },
    b: { deviceId: 'sw', ifaceId: 'p3' },
  });
  return state;
}

describe('simulatePacket — unicast is untouched by any of this', () => {
  it('still reports exactly what it always did, with no broadcast markings', () => {
    const res = simulatePacket(twoPcsOneSwitch(), 'pc1', '192.168.1.11');
    expect(res).toEqual({ success: true, path: ['pc1', 'pc2'] });
    expect(res.broadcast).toBeUndefined();
    expect(res.recipients).toBeUndefined();
  });

  it('and neither is the round trip', () => {
    expect(ping(twoPcsOneSwitch(), 'pc1', '192.168.1.11')).toEqual({
      success: true,
      path: ['pc1', 'pc2'],
    });
  });

  it('a vacant host address still fails as nobody owning it', () => {
    // .250 is a perfectly good host address — it is just unoccupied. That has to
    // stay a different failure from "that is not a host address at all".
    const res = simulatePacket(twoPcsOneSwitch(), 'pc1', '192.168.1.250');
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/owns 192\.168\.1\.250/i);
  });
});

describe('simulatePacket — to the subnet broadcast address', () => {
  it('delivers to every host on the segment, not to one lucky owner', () => {
    const res = simulatePacket(threeHostSegment(), 'pc1', '192.168.1.255');
    expect(res.success).toBe(true);
    expect(res.broadcast).toBe(true);
    expect(res.recipients?.slice().sort()).toEqual(['pc2', 'pc3']);
  });

  it('reports one real leg as the path, with the recipients as the truth', () => {
    // A single ordered hop list cannot describe a frame that fanned out, so the
    // path names the nearest recipient and callers that care read `recipients`.
    const res = simulatePacket(threeHostSegment(), 'pc1', '192.168.1.255');
    expect(res.path[0]).toBe('pc1');
    expect(res.path).toHaveLength(2);
    expect(res.recipients).toContain(res.path[1]);
  });

  it('skips a host whose own mask says that is not its broadcast address', () => {
    // PC2 is a /25: to it, 192.168.1.255 is an address in some other subnet.
    const res = simulatePacket(
      twoPcsOneSwitch({ pc2Mask: '255.255.255.128' }),
      'pc1',
      '192.168.1.255',
    );
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/segment accepted the broadcast/i);
  });

  it('fails when nothing is left on the segment to accept it', () => {
    const res = simulatePacket(twoPcsOneSwitch({ pc2Powered: false }), 'pc1', '192.168.1.255');
    expect(res.success).toBe(false);
    expect(res.broadcast).toBeUndefined();
  });

  it('reads the mask, not the last octet — a /29 broadcasts to .15', () => {
    const slash29 = {
      pc1Ip: '192.168.1.9',
      pc1Mask: '255.255.255.248',
      pc2Ip: '192.168.1.10',
      pc2Mask: '255.255.255.248',
    };
    const bcast = simulatePacket(twoPcsOneSwitch(slash29), 'pc1', '192.168.1.15');
    expect(bcast.broadcast).toBe(true);
    expect(bcast.recipients).toEqual(['pc2']);

    // .255 is not even in this subnet, so it is an ordinary remote address.
    const outside = simulatePacket(twoPcsOneSwitch(slash29), 'pc1', '192.168.1.255');
    expect(outside.success).toBe(false);
    expect(outside.reason).toMatch(/no default gateway/i);
  });

  it('has no broadcast address to find on a /31', () => {
    // RFC 3021: both addresses are hosts, so .1 is a plain unicast peer.
    const res = simulatePacket(
      twoPcsOneSwitch({
        pc1Ip: '10.0.0.0',
        pc1Mask: '255.255.255.254',
        pc2Ip: '10.0.0.1',
        pc2Mask: '255.255.255.254',
      }),
      'pc1',
      '10.0.0.1',
    );
    expect(res).toEqual({ success: true, path: ['pc1', 'pc2'] });
  });
});

describe('simulatePacket — to the network address', () => {
  it('fails: it names the network, not a host on it', () => {
    const res = simulatePacket(twoPcsOneSwitch(), 'pc1', '192.168.1.0');
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/names the network itself, not a host on it/i);
    expect(res.broadcast).toBeUndefined();
  });

  it('fails even when a device is mis-configured with it', () => {
    // The old behaviour: PC2 sat on .0 and the engine happily unicast to it.
    const res = simulatePacket(twoPcsOneSwitch({ pc2Ip: '192.168.1.0' }), 'pc1', '192.168.1.0');
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/names the network itself/i);
  });

  it('reads the mask here too — .8 is the network address of a /29', () => {
    const res = simulatePacket(
      twoPcsOneSwitch({
        pc1Ip: '192.168.1.9',
        pc1Mask: '255.255.255.248',
        pc2Ip: '192.168.1.10',
        pc2Mask: '255.255.255.248',
      }),
      'pc1',
      '192.168.1.8',
    );
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/names the network itself/i);
  });
});

describe('simulatePacket — from an interface that owns a non-host address', () => {
  it('refuses to send from the network address of its own subnet', () => {
    const res = simulatePacket(twoPcsOneSwitch({ pc1Ip: '192.168.1.0' }), 'pc1', '192.168.1.11');
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/configured with 192\.168\.1\.0, the network address/i);
    expect(res.path).toEqual(['pc1']); // it never left the device
  });

  it('refuses to send from the broadcast address of its own subnet', () => {
    const res = simulatePacket(twoPcsOneSwitch({ pc1Ip: '192.168.1.255' }), 'pc1', '192.168.1.11');
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/the broadcast address of its own/i);
  });

  it('applies to whatever mask the interface carries', () => {
    const res = simulatePacket(
      twoPcsOneSwitch({ pc1Ip: '192.168.1.127', pc1Mask: '255.255.255.128' }),
      'pc1',
      '192.168.1.11',
    );
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/the broadcast address/i);
  });

  it('stops the far end answering too, so the round trip fails', () => {
    // PC2 receives the broadcast and has nothing legitimate to reply from.
    const res = ping(twoPcsOneSwitch({ pc2Ip: '192.168.1.255' }), 'pc1', '192.168.1.255');
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/no one on the segment could reply/i);
  });

  it('says so plainly when the address and mask do not parse at all', () => {
    const res = simulatePacket(twoPcsOneSwitch({ pc1Mask: 'not-a-mask' }), 'pc1', '192.168.1.11');
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/is not a valid address and mask/i);
  });
});

describe('ping — to a broadcast address', () => {
  it('succeeds when at least one host can answer, and lists who did', () => {
    const res = ping(threeHostSegment(), 'pc1', '192.168.1.255');
    expect(res.success).toBe(true);
    expect(res.broadcast).toBe(true);
    expect(res.recipients?.slice().sort()).toEqual(['pc2', 'pc3']);
  });

  it('narrows the recipients to the ones that actually replied', () => {
    const state = threeHostSegment();
    // PC3 hears nothing once it is off; PC2 still answers, which is enough.
    state.devices.find((d) => d.id === 'pc3')!.powered = false;
    const res = ping(state, 'pc1', '192.168.1.255');
    expect(res.success).toBe(true);
    expect(res.recipients).toEqual(['pc2']);
  });
});

describe('simulatePacket — the limited broadcast 255.255.255.255', () => {
  it('reaches the whole segment whatever the receiver mask says', () => {
    const res = simulatePacket(
      twoPcsOneSwitch({ pc2Mask: '255.255.255.128' }),
      'pc1',
      '255.255.255.255',
    );
    expect(res.success).toBe(true);
    expect(res.broadcast).toBe(true);
    // Even the /25 host takes this one: it is addressed to everyone on the wire.
    expect(res.recipients).toEqual(['pc2']);
  });

  it('stops at the first router and is never routed onward', () => {
    const state = twoRouterState();
    addRoute(state, 'r1', '20.0.0.0', '255.255.255.0', '172.16.0.2');
    const res = simulatePacket(state, 'pcA', '255.255.255.255');
    expect(res.success).toBe(true);
    expect(res.recipients).toEqual(['r1']); // not R2, and not PC-B
  });
});

describe('simulatePacket — non-host addresses on the far side of a router', () => {
  it('drops a directed broadcast at the router that would have to deliver it', () => {
    const state = twoRouterState();
    addRoute(state, 'r1', '20.0.0.0', '255.255.255.0', '172.16.0.2');
    const res = simulatePacket(state, 'pcA', '20.0.0.255');
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/R2 will not forward a directed broadcast to 20\.0\.0\.255/i);
  });

  it('refuses a remote network address', () => {
    const state = twoRouterState();
    addRoute(state, 'r1', '20.0.0.0', '255.255.255.0', '172.16.0.2');
    const res = simulatePacket(state, 'pcA', '20.0.0.0');
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/names the network behind R2, not a host on it/i);
  });

  it('leaves an ordinary routed unicast exactly as it was', () => {
    const state = twoRouterState();
    addRoute(state, 'r1', '20.0.0.0', '255.255.255.0', '172.16.0.2');
    expect(simulatePacket(state, 'pcA', '20.0.0.10')).toEqual({
      success: true,
      path: ['pcA', 'r1', 'r2', 'pcB'],
    });
  });
});
