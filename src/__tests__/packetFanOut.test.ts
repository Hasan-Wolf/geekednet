/**
 * Fan-out rendering: turning one engine result into the cable runs the canvas
 * draws heads along.
 *
 * The engine answers "who got this frame"; this layer answers "down which wires,
 * exactly". The contract worth defending is that it never answers with a wire
 * that is not there — a head sliding between two devices with no cable between
 * them teaches the student a link they do not have.
 *
 * Every case here is driven through the real `simulatePacket`, so these are the
 * routes the canvas would actually be handed, not a hand-written stand-in.
 */
import { describe, it, expect } from 'vitest';
import { simulatePacket, type NetworkState } from '../../engine/index.js';
import { blockedAt, cableRoute, packetCableRoutes } from '../cableRoute.js';

/** Hosts on one switch. Masks default to /24; give one its own to make it
 *  disagree about what the broadcast address is. */
function segment(hosts: Array<{ id: string; ip: string; mask?: string }>): NetworkState {
  return {
    devices: [
      ...hosts.map((h, i) => ({
        id: h.id,
        kind: 'pc' as const,
        label: h.id.toUpperCase(),
        powered: true,
        x: i * 100,
        y: 0,
        interfaces: [
          { id: 'e0', name: 'eth0', ip: h.ip, mask: h.mask ?? '255.255.255.0', linkId: 'l' + i },
        ],
      })),
      {
        id: 'sw',
        kind: 'switch' as const,
        label: 'Switch',
        powered: true,
        x: 0,
        y: 200,
        interfaces: hosts.map((_, i) => ({ id: 'p' + i, name: 'port' + i, linkId: 'l' + i })),
      },
    ],
    links: hosts.map((h, i) => ({
      id: 'l' + i,
      a: { deviceId: h.id, ifaceId: 'e0' },
      b: { deviceId: 'sw', ifaceId: 'p' + i },
    })),
  };
}

/** PC-A -- R1 == R2 -- PC-B, with both routers already taught the way across. */
function twoRouters(): NetworkState {
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
        interfaces: [
          { id: 'e0', name: 'eth0', ip: '10.0.0.10', mask: '255.255.255.0', linkId: 'la' },
        ],
      },
      {
        id: 'r1',
        kind: 'router',
        label: 'R1',
        powered: true,
        x: 150,
        y: 0,
        routes: [{ dst: '20.0.0.0', mask: '255.255.255.0', gateway: '172.16.0.2' }],
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
        x: 300,
        y: 0,
        routes: [{ dst: '10.0.0.0', mask: '255.255.255.0', gateway: '172.16.0.1' }],
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
        x: 450,
        y: 0,
        gateway: '20.0.0.1',
        interfaces: [
          { id: 'e0', name: 'eth0', ip: '20.0.0.10', mask: '255.255.255.0', linkId: 'lb' },
        ],
      },
    ],
    links: [
      { id: 'la', a: { deviceId: 'pcA', ifaceId: 'e0' }, b: { deviceId: 'r1', ifaceId: 'g0' } },
      { id: 'bb', a: { deviceId: 'r1', ifaceId: 'g1' }, b: { deviceId: 'r2', ifaceId: 'g1' } },
      { id: 'lb', a: { deviceId: 'r2', ifaceId: 'g0' }, b: { deviceId: 'pcB', ifaceId: 'e0' } },
    ],
  };
}

/** Is there really a cable between these two devices? */
function isCabled(net: NetworkState, a: string, b: string): boolean {
  return net.links.some(
    (l) => (l.a.deviceId === a && l.b.deviceId === b) || (l.a.deviceId === b && l.b.deviceId === a),
  );
}

/** The guarantee every drawn run has to meet, whatever produced it: each step is
 *  a cable the student can see on the canvas. */
function expectOnRealCables(net: NetworkState, routes: string[][]) {
  for (const route of routes) {
    for (let i = 1; i < route.length; i += 1) {
      const step = route[i - 1] + ' -> ' + route[i];
      expect(isCabled(net, route[i - 1], route[i]), step + ' is not a cable in this topology')
        .toBe(true);
    }
  }
}

const asText = (routes: string[][]) => routes.map((r) => r.join(' > ')).sort();

describe('fan-out to multiple recipients', () => {
  it('gives every recipient its own run out of the sender', () => {
    const net = segment([
      { id: 'pc1', ip: '192.168.1.10' },
      { id: 'pc2', ip: '192.168.1.11' },
      { id: 'pc3', ip: '192.168.1.12' },
      { id: 'pc4', ip: '192.168.1.13' },
    ]);
    const res = simulatePacket(net, 'pc1', '192.168.1.255');
    expect(res.broadcast).toBe(true);

    const routes = packetCableRoutes(net, res.path, res.recipients);
    expect(routes).toHaveLength(3);
    expect(asText(routes)).toEqual(['pc1 > sw > pc2', 'pc1 > sw > pc3', 'pc1 > sw > pc4']);
    expectOnRealCables(net, routes);
  });

  it('routes through however many forwarding devices sit in the way', () => {
    // Two switches chained. Nothing is special-cased for one switch and three
    // PCs, so the extra hop falls out of the cabling on its own.
    const net = segment([
      { id: 'pc1', ip: '192.168.1.10' },
      { id: 'pc2', ip: '192.168.1.11' },
    ]);
    net.devices.push({
      id: 'sw2',
      kind: 'switch',
      label: 'Switch 2',
      powered: true,
      x: 0,
      y: 400,
      interfaces: [
        { id: 'u', name: 'uplink', linkId: 'trunk' },
        { id: 'p0', name: 'port0', linkId: 'l9' },
      ],
    });
    net.devices.push({
      id: 'pc9',
      kind: 'pc',
      label: 'PC9',
      powered: true,
      x: 300,
      y: 400,
      interfaces: [
        { id: 'e0', name: 'eth0', ip: '192.168.1.19', mask: '255.255.255.0', linkId: 'l9' },
      ],
    });
    const sw = net.devices.find((d) => d.id === 'sw')!;
    sw.interfaces.push({ id: 'up', name: 'uplink', linkId: 'trunk' });
    net.links.push(
      { id: 'trunk', a: { deviceId: 'sw', ifaceId: 'up' }, b: { deviceId: 'sw2', ifaceId: 'u' } },
      { id: 'l9', a: { deviceId: 'sw2', ifaceId: 'p0' }, b: { deviceId: 'pc9', ifaceId: 'e0' } },
    );

    const res = simulatePacket(net, 'pc1', '192.168.1.255');
    expect(res.recipients?.slice().sort()).toEqual(['pc2', 'pc9']);

    const routes = packetCableRoutes(net, res.path, res.recipients);
    expect(asText(routes)).toEqual(['pc1 > sw > pc2', 'pc1 > sw > sw2 > pc9']);
    expectOnRealCables(net, routes);
  });

  it('works the same when the flooding device is a hub', () => {
    const net = segment([
      { id: 'pc1', ip: '192.168.1.10' },
      { id: 'pc2', ip: '192.168.1.11' },
      { id: 'pc3', ip: '192.168.1.12' },
    ]);
    net.devices.find((d) => d.id === 'sw')!.kind = 'hub';
    const res = simulatePacket(net, 'pc1', '192.168.1.255');
    expect(asText(packetCableRoutes(net, res.path, res.recipients))).toEqual([
      'pc1 > sw > pc2',
      'pc1 > sw > pc3',
    ]);
  });
});

describe('a mixed segment where only some devices accept', () => {
  it('draws a branch only to the hosts the engine says took it', () => {
    // PC3 is a /25: to it, .255 is an address in some other subnet, so it never
    // receives the frame and must never get a head drawn toward it.
    const net = segment([
      { id: 'pc1', ip: '192.168.1.10' },
      { id: 'pc2', ip: '192.168.1.11' },
      { id: 'pc3', ip: '192.168.1.12', mask: '255.255.255.128' },
      { id: 'pc4', ip: '192.168.1.13' },
    ]);
    const res = simulatePacket(net, 'pc1', '192.168.1.255');
    expect(res.recipients?.slice().sort()).toEqual(['pc2', 'pc4']);

    const routes = packetCableRoutes(net, res.path, res.recipients);
    expect(asText(routes)).toEqual(['pc1 > sw > pc2', 'pc1 > sw > pc4']);
    expect(routes.flat()).not.toContain('pc3');
    expectOnRealCables(net, routes);
  });

  it('leaves out a host that is powered down', () => {
    const net = segment([
      { id: 'pc1', ip: '192.168.1.10' },
      { id: 'pc2', ip: '192.168.1.11' },
      { id: 'pc3', ip: '192.168.1.12' },
    ]);
    net.devices.find((d) => d.id === 'pc3')!.powered = false;
    const res = simulatePacket(net, 'pc1', '192.168.1.255');
    expect(asText(packetCableRoutes(net, res.path, res.recipients))).toEqual(['pc1 > sw > pc2']);
  });

  it('drops a recipient it cannot reach on real cable rather than inventing one', () => {
    // Not something the engine produces — this is the guard that a stale or
    // hand-built result can never draw a link the canvas does not have.
    const net = segment([
      { id: 'pc1', ip: '192.168.1.10' },
      { id: 'pc2', ip: '192.168.1.11' },
      { id: 'pc3', ip: '192.168.1.12' },
    ]);
    net.links = net.links.filter((l) => l.id !== 'l2'); // unplug PC3
    const routes = packetCableRoutes(net, ['pc1', 'pc2'], ['pc2', 'pc3']);
    expect(asText(routes)).toEqual(['pc1 > sw > pc2']);
    expectOnRealCables(net, routes);

    expect(packetCableRoutes(net, ['pc1'], ['ghost'])).toEqual([]);
  });
});

describe('a directed broadcast stopping at a router', () => {
  it('ends the run at the router that refused it, on real cable', () => {
    const net = twoRouters();
    const res = simulatePacket(net, 'pcA', '20.0.0.255');

    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/R2 will not forward a directed broadcast/i);

    // The head travels PC-A -> R1 -> R2 and stops. It must not appear on the far
    // cable to PC-B, which the packet never crossed.
    const routes = packetCableRoutes(net, res.path, res.recipients);
    expect(routes).toEqual([['pcA', 'r1', 'r2']]);
    expect(routes.flat()).not.toContain('pcB');
    expectOnRealCables(net, routes);
  });

  it('names R2 as the place to look', () => {
    const net = twoRouters();
    const res = simulatePacket(net, 'pcA', '20.0.0.255');
    expect(blockedAt(res.path, res.success)).toBe('r2');
    const drawn = cableRoute(net, res.path);
    expect(drawn[drawn.length - 1]).toBe('r2');
  });

  it('marks nothing when the packet got where it was going', () => {
    const net = twoRouters();
    const res = simulatePacket(net, 'pcA', '20.0.0.10');
    expect(res.success).toBe(true);
    expect(blockedAt(res.path, res.success)).toBeUndefined();
  });

  it('marks nothing when the packet never left the sender', () => {
    // The banner already says why, and ringing the device whose terminal you are
    // typing into points at nothing.
    const net = segment([
      { id: 'pc1', ip: '192.168.1.0' },
      { id: 'pc2', ip: '192.168.1.11' },
    ]);
    const res = simulatePacket(net, 'pc1', '192.168.1.11');
    expect(res.success).toBe(false);
    expect(res.path).toEqual(['pc1']);
    expect(blockedAt(res.path, res.success)).toBeUndefined();
  });
});

describe('unicast is unchanged', () => {
  it('still produces exactly one run, the same one as before', () => {
    const net = segment([
      { id: 'pc1', ip: '192.168.1.10' },
      { id: 'pc2', ip: '192.168.1.11' },
      { id: 'pc3', ip: '192.168.1.12' },
    ]);
    const res = simulatePacket(net, 'pc1', '192.168.1.11');
    expect(res.broadcast).toBeUndefined();
    expect(packetCableRoutes(net, res.path, res.recipients)).toEqual([cableRoute(net, res.path)]);
    expect(packetCableRoutes(net, res.path, res.recipients)).toEqual([['pc1', 'sw', 'pc2']]);
  });

  it('still produces one run across routers', () => {
    const net = twoRouters();
    const res = simulatePacket(net, 'pcA', '20.0.0.10');
    expect(packetCableRoutes(net, res.path, res.recipients)).toEqual([['pcA', 'r1', 'r2', 'pcB']]);
  });
});
