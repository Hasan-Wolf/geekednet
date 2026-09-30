/**
 * The engine's hop list is layer 3; the canvas has to draw layer 1. These tests
 * pin down the expansion for every shape a lab might be wired in — nothing here
 * refers to a particular lab, because the renderer mustn't either.
 */
import { describe, it, expect } from 'vitest';
import { ping, verifyTargetIp, type Device, type NetworkState } from '../../engine/index.js';
import { labs } from '../../engine/labs/index.js';
import { cableRoute } from '../cableRoute.js';

/** Minimal device — only id/kind matter to the router; x/y and interfaces are
 *  noise here, since connectivity is read from `links`. */
function dev(id: string, kind: Device['kind']): Device {
  return { id, kind, label: id, interfaces: [], powered: true, x: 0, y: 0 };
}

/** Build a network from "a-b" cable strings. Kinds come from an id prefix:
 *  `sw*` switch, `hub*` hub, `r*` router, anything else a PC. */
function netOf(...cables: string[]): NetworkState {
  const ids = new Set<string>();
  const links = cables.map((c, i) => {
    const [a, b] = c.split('-');
    ids.add(a);
    ids.add(b);
    return { id: `l${i}`, a: { deviceId: a, ifaceId: 'x' }, b: { deviceId: b, ifaceId: 'y' } };
  });
  const kind = (id: string): Device['kind'] =>
    id.startsWith('sw') ? 'switch' : id.startsWith('hub') ? 'hub' : id.startsWith('r') ? 'router' : 'pc';
  return { devices: [...ids].map((id) => dev(id, kind(id))), links };
}

describe('cableRoute — any chain, derived from the cabling', () => {
  it('splices in the switch the engine leaves out (PC → switch → PC)', () => {
    const net = netOf('pc1-sw', 'sw-pc2');
    // This is exactly what `ping` hands back for lab one: no switch in sight.
    expect(cableRoute(net, ['pc1', 'pc2'])).toEqual(['pc1', 'sw', 'pc2']);
  });

  it('leaves a directly-cabled router chain alone (PC → R → R → PC)', () => {
    const net = netOf('pcR-r1', 'r1-r2', 'r2-pcB');
    expect(cableRoute(net, ['pcR', 'r1', 'r2', 'pcB'])).toEqual(['pcR', 'r1', 'r2', 'pcB']);
  });

  it('walks a stack of switches between two hops', () => {
    const net = netOf('pc1-swA', 'swA-swB', 'swB-swC', 'swC-pc2');
    expect(cableRoute(net, ['pc1', 'pc2'])).toEqual(['pc1', 'swA', 'swB', 'swC', 'pc2']);
  });

  it('handles a long mixed chain, expanding every leg', () => {
    const net = netOf('pc1-sw1', 'sw1-r1', 'r1-r2', 'r2-sw2', 'sw2-hub1', 'hub1-pc2');
    expect(cableRoute(net, ['pc1', 'r1', 'r2', 'pc2'])).toEqual([
      'pc1', 'sw1', 'r1', 'r2', 'sw2', 'hub1', 'pc2',
    ]);
  });

  it('picks only the branch that leads to the destination', () => {
    // One switch, four hosts hanging off it: the route must not wander into the
    // branches that go nowhere.
    const net = netOf('pc1-sw', 'pc2-sw', 'pc3-sw', 'pc4-sw');
    expect(cableRoute(net, ['pc1', 'pc3'])).toEqual(['pc1', 'sw', 'pc3']);
  });

  it('takes the fewest cables when a segment is meshed', () => {
    const net = netOf('pc1-swA', 'swA-pc2', 'pc1-swB', 'swB-swC', 'swC-pc2');
    expect(cableRoute(net, ['pc1', 'pc2'])).toEqual(['pc1', 'swA', 'pc2']);
  });

  it('never detours a layer-2 leg through a router', () => {
    // pc1 reaches r1 either through the switch (what actually happens) or
    // "through" r2 — same hop count, so only the layer-2 rule separates them.
    const net = netOf('pc1-r2', 'r2-r1', 'pc1-sw', 'sw-r1');
    expect(cableRoute(net, ['pc1', 'r1'])).toEqual(['pc1', 'sw', 'r1']);
  });

  it('falls back to the bare pair when two hops are not cabled together', () => {
    const net = netOf('pc1-sw', 'pc2-swOther');
    expect(cableRoute(net, ['pc1', 'pc2'])).toEqual(['pc1', 'pc2']);
  });

  it('is a no-op on trivial input', () => {
    const net = netOf('pc1-sw', 'sw-pc2');
    expect(cableRoute(net, [])).toEqual([]);
    expect(cableRoute(net, ['pc1'])).toEqual(['pc1']);
  });

  it('survives a hop that is not on the canvas at all', () => {
    const net = netOf('pc1-sw', 'sw-pc2');
    expect(cableRoute(net, ['pc1', 'ghost'])).toEqual(['pc1', 'ghost']);
  });
});

describe('cableRoute — against the real labs', () => {
  /** Every lab's verifying ping, walked on a solved copy of its own state. */
  function solvedPath(labId: string, mutate: (net: NetworkState) => void): string[] {
    const lab = labs.find((l) => l.id === labId)!;
    const net = JSON.parse(JSON.stringify(lab.initialState)) as NetworkState;
    mutate(net);
    // Resolved rather than read off the lab: tier 0 names its destination by
    // device, because the address there is the student's to choose.
    const target = verifyTargetIp(lab, net);
    expect(target, `${labId} verify resolves to no destination once solved`).toBeDefined();
    const result = ping(net, lab.verify!.from, target!);
    expect(result.success, `${labId} should be reachable once solved`).toBe(true);
    return cableRoute(net, result.path);
  }

  it('tier 0 and tier 1 pings pass through the switch on the canvas', () => {
    const setIp = (net: NetworkState, id: string, ip: string) => {
      const iface = net.devices.find((d) => d.id === id)!.interfaces[0];
      iface.ip = ip;
      iface.mask = '255.255.255.0';
    };
    // The engine reports ['pc1','pc2'] for both; the canvas must draw three.
    expect(
      solvedPath('tier0-first-ping.learn', (net) => {
        setIp(net, 'pc1', '192.168.1.10');
        setIp(net, 'pc2', '192.168.1.11');
      }),
    ).toEqual(['pc1', 'sw', 'pc2']);

    expect(
      solvedPath('tier1-fix-mask.learn', (net) => setIp(net, 'pc2', '192.168.1.11')),
    ).toEqual(['pc1', 'sw', 'pc2']);
  });

  it('the tier 2 route is already complete and is left untouched', () => {
    expect(
      solvedPath('tier2-static-route.learn', (net) => {
        const route = (id: string, dst: string, gateway: string) => {
          const d = net.devices.find((x) => x.id === id)!;
          d.routes = [...(d.routes ?? []), { dst, mask: '255.255.255.0', gateway }];
        };
        route('r1', '20.0.0.0', '172.16.0.2');
        route('r2', '10.0.0.0', '172.16.0.1');
      }),
    ).toEqual(['pcR', 'r1', 'r2', 'pcB']);
  });
});
