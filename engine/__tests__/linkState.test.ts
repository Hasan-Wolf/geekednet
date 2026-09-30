/**
 * The link light.
 *
 * The rule the whole file exists to defend: a port with nothing in it, or
 * something dead at the far end, is never green. Everything else follows from
 * that — including the amber band, which is for a link that exists and does not
 * work properly, not for a link that is merely unused.
 */
import { describe, it, expect } from 'vitest';
import type { Device, NetworkState } from '../types.js';
import { deviceLinkStatus, interfaceLinkStatus } from '../linkState.js';
import { labs } from '../labs/index.js';

/** PC1 -- Switch -- PC2, the shape of the first two labs. */
function twoPcsOneSwitch(): NetworkState {
  const pc = (id: string, linkId: string, x: number): Device => ({
    id,
    kind: 'pc',
    label: id.toUpperCase(),
    powered: true,
    x,
    y: 0,
    interfaces: [{ id: 'e0', name: 'eth0', ip: null, mask: null, linkId }],
  });
  return {
    devices: [
      pc('pc1', 'l1', 0),
      pc('pc2', 'l2', 400),
      {
        id: 'sw',
        kind: 'switch',
        label: 'Switch',
        powered: true,
        x: 200,
        y: 0,
        interfaces: [
          { id: 'p1', name: 'port1', linkId: 'l1' },
          { id: 'p2', name: 'port2', linkId: 'l2' },
          { id: 'p3', name: 'port3', linkId: null },
        ],
      },
    ],
    links: [
      { id: 'l1', a: { deviceId: 'pc1', ifaceId: 'e0' }, b: { deviceId: 'sw', ifaceId: 'p1' } },
      { id: 'l2', a: { deviceId: 'pc2', ifaceId: 'e0' }, b: { deviceId: 'sw', ifaceId: 'p2' } },
    ],
  };
}

const health = (net: NetworkState, id: string) => deviceLinkStatus(net, id).health;

/** What the store does when a cable is pulled: drop the link, clear both ends. */
function unplug(net: NetworkState, linkId: string) {
  net.links = net.links.filter((l) => l.id !== linkId);
  for (const d of net.devices) {
    for (const i of d.interfaces) if (i.linkId === linkId) i.linkId = null;
  }
}

describe('a healthy segment', () => {
  it('is green end to end', () => {
    const net = twoPcsOneSwitch();
    expect(health(net, 'pc1')).toBe('up');
    expect(health(net, 'pc2')).toBe('up');
    expect(health(net, 'sw')).toBe('up');
  });

  it('does not hold an unused port against a switch', () => {
    // port3 has never had a cable in it. A six-port switch using two of them is
    // a normal switch, not a broken one.
    const net = twoPcsOneSwitch();
    expect(interfaceLinkStatus(net, 'sw', 'p3').health).toBe('down');
    expect(health(net, 'sw')).toBe('up');
  });
});

describe('pulling a cable', () => {
  it('turns the host that lost its only link red', () => {
    const net = twoPcsOneSwitch();
    unplug(net, 'l1');
    expect(health(net, 'pc1')).toBe('down');
    expect(deviceLinkStatus(net, 'pc1').reason).toMatch(/nothing plugged in/i);
  });

  it('shows at the switch too, which is now forwarding between nothing', () => {
    const net = twoPcsOneSwitch();
    unplug(net, 'l1');
    expect(health(net, 'sw')).toBe('degraded');
    expect(deviceLinkStatus(net, 'sw').reason).toMatch(/only one live link/i);
  });

  it('leaves the far side of the segment alone', () => {
    const net = twoPcsOneSwitch();
    unplug(net, 'l1');
    expect(health(net, 'pc2')).toBe('up'); // its own cable is still fine
  });

  it('takes the switch to red once the last cable is out', () => {
    const net = twoPcsOneSwitch();
    unplug(net, 'l1');
    unplug(net, 'l2');
    expect(health(net, 'sw')).toBe('down');
    expect(health(net, 'pc1')).toBe('down');
    expect(health(net, 'pc2')).toBe('down');
  });
});

describe('power', () => {
  it('a powered-off device is down, whatever is plugged into it', () => {
    const net = twoPcsOneSwitch();
    net.devices.find((d) => d.id === 'pc1')!.powered = false;
    expect(health(net, 'pc1')).toBe('down');
    expect(deviceLinkStatus(net, 'pc1').reason).toMatch(/powered off/i);
  });

  it('and takes the light at the other end of its cable down with it', () => {
    // No link light comes up against a dead box. This is the case a power-only
    // indicator got wrong: PC1 stayed green while its peer was off.
    const net = twoPcsOneSwitch();
    net.devices.find((d) => d.id === 'pc2')!.powered = false;
    expect(interfaceLinkStatus(net, 'sw', 'p2').health).toBe('down');
    expect(health(net, 'sw')).toBe('down');
    expect(deviceLinkStatus(net, 'sw').reason).toMatch(/PC2 at the far end is powered off/i);
  });

  it('a switch with one live link and one dead peer is down, not amber', () => {
    // Worst state wins: a broken cable outranks "only one link".
    const net = twoPcsOneSwitch();
    net.devices.find((d) => d.id === 'pc1')!.powered = false;
    expect(health(net, 'sw')).toBe('down');
  });
});

describe('layer-1 mismatches are amber', () => {
  function mismatched(mutate: (net: NetworkState) => void): NetworkState {
    const net = twoPcsOneSwitch();
    mutate(net);
    return net;
  }
  const iface = (net: NetworkState, dev: string, id: string) =>
    net.devices.find((d) => d.id === dev)!.interfaces.find((i) => i.id === id)!;

  it('flags a speed mismatch across a cable', () => {
    const net = mismatched((n) => {
      iface(n, 'pc1', 'e0').speed = 100;
      iface(n, 'sw', 'p1').speed = 1000;
    });
    expect(health(net, 'pc1')).toBe('degraded');
    expect(deviceLinkStatus(net, 'pc1').reason).toMatch(/speed mismatch.*100 vs 1000/i);
    expect(health(net, 'sw')).toBe('degraded'); // both ends report it
  });

  it('flags a duplex mismatch across a cable', () => {
    const net = mismatched((n) => {
      iface(n, 'pc1', 'e0').duplex = 'half';
      iface(n, 'sw', 'p1').duplex = 'full';
    });
    expect(health(net, 'pc1')).toBe('degraded');
    expect(deviceLinkStatus(net, 'pc1').reason).toMatch(/duplex mismatch.*half vs full/i);
  });

  it('stays green when both ends agree', () => {
    const net = mismatched((n) => {
      iface(n, 'pc1', 'e0').speed = 1000;
      iface(n, 'sw', 'p1').speed = 1000;
      iface(n, 'pc1', 'e0').duplex = 'full';
      iface(n, 'sw', 'p1').duplex = 'full';
    });
    expect(health(net, 'pc1')).toBe('up');
    expect(health(net, 'sw')).toBe('up');
  });

  it('treats one side stating a value as auto-negotiation, not a fault', () => {
    // Otherwise every lab that annotated a single port would light up amber.
    const net = mismatched((n) => {
      iface(n, 'pc1', 'e0').speed = 100;
      iface(n, 'pc1', 'e0').duplex = 'half';
    });
    expect(health(net, 'pc1')).toBe('up');
  });

  it('never outranks a link that is actually down', () => {
    const net = mismatched((n) => {
      iface(n, 'pc1', 'e0').speed = 100;
      iface(n, 'sw', 'p1').speed = 1000;
      n.devices.find((d) => d.id === 'pc1')!.powered = false;
    });
    expect(health(net, 'sw')).toBe('down');
  });
});

describe('a canvas being built from nothing', () => {
  it('a device with no cables is red, not green', () => {
    const lonely: NetworkState = {
      devices: [
        {
          id: 'pc1',
          kind: 'pc',
          label: 'PC1',
          powered: true,
          x: 0,
          y: 0,
          interfaces: [{ id: 'e0', name: 'eth0', ip: null, mask: null, linkId: null }],
        },
      ],
      links: [],
    };
    expect(health(lonely, 'pc1')).toBe('down');
  });

  it('a port pointing at a cable that is gone is down, never green', () => {
    const net = twoPcsOneSwitch();
    net.links = net.links.filter((l) => l.id !== 'l1'); // link dropped, linkId left behind
    expect(interfaceLinkStatus(net, 'pc1', 'e0').health).toBe('down');
    expect(interfaceLinkStatus(net, 'pc1', 'e0').reason).toMatch(/goes nowhere/i);
    expect(health(net, 'pc1')).toBe('down');
  });

  it('reports down for a device that is not there at all', () => {
    expect(health(twoPcsOneSwitch(), 'ghost')).toBe('down');
  });
});

describe('the shipped labs', () => {
  it('every device starts with a link light that is not red', () => {
    // A lab that opens with a device showing a fault it did not intend would
    // read as a broken simulator rather than a puzzle.
    for (const lab of labs) {
      for (const device of lab.initialState.devices) {
        const status = deviceLinkStatus(lab.initialState, device.id);
        expect(status.health, `${lab.id}: ${device.label} — ${status.reason}`).not.toBe('down');
      }
    }
  });

  it('and no lab declares a layer-1 mismatch it did not mean to', () => {
    for (const lab of labs) {
      for (const device of lab.initialState.devices) {
        const status = deviceLinkStatus(lab.initialState, device.id);
        expect(status.health, `${lab.id}: ${device.label} — ${status.reason}`).toBe('up');
      }
    }
  });
});
