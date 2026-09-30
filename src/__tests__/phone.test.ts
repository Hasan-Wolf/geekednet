/**
 * The phone layout, held to its four promises.
 *
 * 1. The lab arrives **built and addressed**. Not "looks addressed" — the
 *    engine's own `isLabComplete` has to agree, and the lab's own sign-off ping
 *    has to come back, for every lab in the registry. That is what stops a
 *    fourth lab shipping a phone view that cannot ping.
 * 2. It is **the same topology**. `solveLab` may fill in addresses, masks and
 *    routes and nothing else: no device moved, added, removed or re-cabled. A
 *    phone-only copy of a lab's wiring is exactly what this file exists to stop.
 * 3. It is **read-only and unscored**. A lab handed over already solved is one
 *    tap from banking XP it hasn't earned, so phone mode must be impossible to
 *    complete a lab from — including with the very ping the lab is signed off
 *    with on desktop.
 * 4. **Desktop is untouched.** Leaving the phone layout puts the player's own
 *    lab back, broken starting state and all, on the lab they were playing —
 *    which the phone's picker is not allowed to have changed.
 */
import { describe, it, expect } from 'vitest';
import {
  isLabComplete,
  isHostAddress,
  inNetwork,
  ping,
  verifyTargetIp,
  type Lab,
  type NetworkState,
} from '../../engine/index.js';
import { ALL_LABS, useStore } from '../store.js';
import { BOX_H, NODE_W } from '../components/Canvas.js';
import { canvasBounds } from '../phone/PhoneCanvas.js';
import { phonePing } from '../phone/phonePing.js';
import { pickHostAddress, solveLab } from '../phone/solveLab.js';
import { PHONE_BREAKPOINT, PHONE_MEDIA_QUERY } from '../phone/usePhoneLayout.js';

const s = () => useStore.getState();

/** The campaign labs — the sandbox has nothing to build or address. */
const MISSIONS: Lab[] = ALL_LABS.filter((l) => l.id !== 'sandbox');
const cases = MISSIONS.map((l) => [l.id, l] as const);

const TIER0 = 'tier0-first-ping.learn';
const TIER2 = 'tier2-static-route.learn';

/** Fresh player, nothing banked, sitting on `labId` on the desktop. */
function startOnDesktop(labId: string) {
  s().resetProgress();
  s().loadLab(labId);
}

/** Every address configured anywhere, for the "no two hosts clash" checks. */
function addresses(net: NetworkState): string[] {
  return net.devices.flatMap((d) => d.interfaces.map((i) => i.ip)).filter((ip): ip is string => !!ip);
}

describe('a lab arrives built and addressed', () => {
  it.each(cases)('%s satisfies every one of its own objectives', (_id, lab) => {
    const solved = solveLab(lab);
    const failing = lab.objectives.filter((o) => !isLabComplete(solved, { ...lab, objectives: [o] }));
    expect(failing.map((o) => o.description)).toEqual([]);
    expect(isLabComplete(solved, lab)).toBe(true);
  });

  it.each(cases)('%s carries the ping the phone offers', (_id, lab) => {
    const solved = solveLab(lab);
    const run = phonePing(lab, solved);
    expect(run, 'no ping to offer').not.toBeNull();
    const result = ping(solved, run!.fromId, run!.toIp);
    expect(result.success, `${run!.fromLabel} → ${run!.toIp}: ${result.reason}`).toBe(true);
  });

  it.each(cases)('%s is not already solved before the phone touches it', (_id, lab) => {
    // Otherwise the tests above would pass on a `solveLab` that did nothing at
    // all — the labs are meant to start broken.
    expect(isLabComplete(lab.initialState, lab)).toBe(false);
  });
});

describe('it is the same topology', () => {
  it.each(cases)('%s keeps every device where the lab put it', (_id, lab) => {
    const solved = solveLab(lab);
    const shape = (net: NetworkState) =>
      net.devices.map((d) => ({
        id: d.id,
        kind: d.kind,
        label: d.label,
        x: d.x,
        y: d.y,
        powered: d.powered,
        ports: d.interfaces.map((i) => ({ id: i.id, name: i.name, linkId: i.linkId ?? null })),
      }));
    expect(shape(solved)).toEqual(shape(lab.initialState));
  });

  it.each(cases)('%s keeps every cable the lab ran', (_id, lab) => {
    expect(solveLab(lab).links).toEqual(lab.initialState.links);
  });

  it.each(cases)('%s leaves the lab data itself alone', (_id, lab) => {
    const before = structuredClone(lab.initialState);
    solveLab(lab);
    // A lab's initialState is shared by every session that loads it; solving it
    // in place would hand the desktop a pre-solved mission.
    expect(lab.initialState).toEqual(before);
  });

  it('is idempotent — solving a solved lab changes nothing', () => {
    const lab = MISSIONS.find((l) => l.id === TIER2)!;
    const once = solveLab(lab);
    const twice = solveLab({ ...lab, initialState: once });
    expect(twice).toEqual(once);
  });
});

describe('addresses it has to choose itself', () => {
  // Mission 1 names a network and lets the student pick the host addresses, so
  // the solver has to pick two that the objective will actually accept.
  const tier0 = () => solveLab(MISSIONS.find((l) => l.id === TIER0)!);

  it('gives both PCs a usable host address on the lab’s network', () => {
    const net = tier0();
    for (const id of ['pc1', 'pc2']) {
      const iface = net.devices.find((d) => d.id === id)!.interfaces[0];
      expect(iface.mask, id).toBe('255.255.255.0');
      expect(inNetwork(iface.ip!, '192.168.1.0', '255.255.255.0'), id).toBe(true);
      expect(isHostAddress(iface.ip!, '255.255.255.0'), id).toBe(true);
    }
  });

  it('never hands the same address to two interfaces', () => {
    const all = addresses(tier0());
    expect(new Set(all).size).toBe(all.length);
  });

  it('starts at the tenth address, where a lab’s own hints start', () => {
    expect(pickHostAddress('192.168.1.0', '255.255.255.0', new Set())).toBe('192.168.1.10');
  });

  it('steps past an address already in use', () => {
    expect(pickHostAddress('192.168.1.0', '255.255.255.0', new Set(['192.168.1.10']))).toBe(
      '192.168.1.11',
    );
  });

  it('never returns the network or broadcast address', () => {
    // A /30 has exactly two host addresses, both below the preferred tenth.
    expect(pickHostAddress('10.0.0.0', '255.255.255.252', new Set())).toBe('10.0.0.1');
    expect(pickHostAddress('10.0.0.0', '255.255.255.252', new Set(['10.0.0.1']))).toBe('10.0.0.2');
  });

  it('gives up rather than inventing an address when the subnet is full', () => {
    const full = new Set(['10.0.0.1', '10.0.0.2']);
    expect(pickHostAddress('10.0.0.0', '255.255.255.252', full)).toBeUndefined();
  });

  it('leaves an interface that already satisfies the objective exactly as it is', () => {
    const lab = MISSIONS.find((l) => l.id === TIER0)!;
    const pre = structuredClone(lab.initialState);
    pre.devices.find((d) => d.id === 'pc1')!.interfaces[0].ip = '192.168.1.77';
    pre.devices.find((d) => d.id === 'pc1')!.interfaces[0].mask = '255.255.255.0';
    const solved = solveLab({ ...lab, initialState: pre });
    expect(solved.devices.find((d) => d.id === 'pc1')!.interfaces[0].ip).toBe('192.168.1.77');
  });

  it('does not invent a route a lab never asked for', () => {
    const lab = MISSIONS.find((l) => l.id === TIER2)!;
    const solved = solveLab(lab);
    const r1 = solved.devices.find((d) => d.id === 'r1')!;
    expect(r1.routes).toEqual([
      { dst: '20.0.0.0', mask: '255.255.255.0', gateway: '172.16.0.2' },
    ]);
  });
});

describe('the ping the one button runs', () => {
  it.each(cases)('%s runs the lab’s own sign-off ping', (_id, lab) => {
    const solved = solveLab(lab);
    const run = phonePing(lab, solved)!;
    expect(run.fromId).toBe(lab.verify!.from);
    expect(run.toIp).toBe(verifyTargetIp(lab, solved));
  });

  it('falls back to the topology demo’s derivation when a lab names no ping', () => {
    const lab = MISSIONS.find((l) => l.id === TIER0)!;
    const solved = solveLab(lab);
    const run = phonePing({ ...lab, verify: undefined }, solved);
    // First host to the addressed host furthest from it by cable — see demoPing.
    expect(run).not.toBeNull();
    expect(run!.fromId).toBe('pc1');
    expect(ping(solved, run!.fromId, run!.toIp).success).toBe(true);
  });

  it('offers nothing to ping on an empty canvas', () => {
    const lab = MISSIONS.find((l) => l.id === TIER0)!;
    expect(phonePing({ ...lab, verify: undefined }, { devices: [], links: [] })).toBeNull();
  });
});

describe('phone mode is read-only and unscored', () => {
  it('puts the solved lab on the canvas without touching the desktop’s lab', () => {
    startOnDesktop(TIER0);
    s().loadPhoneLab(TIER2);

    expect(s().phoneMode).toBe(true);
    expect(s().phoneLabId).toBe(TIER2);
    // The lab the player is actually playing is theirs, not the phone's.
    expect(s().activeLabId).toBe(TIER0);
    expect(s().network).toEqual(solveLab(ALL_LABS.find((l) => l.id === TIER2)!));
    // Nothing is graded here, so there is nothing to show as graded.
    expect(s().objectiveResults).toEqual([]);
    expect(s().verifyStatus).toBe('none');
  });

  it.each(cases)('cannot bank %s, even with the lab’s own sign-off ping', (id, lab) => {
    startOnDesktop(TIER0);
    s().loadPhoneLab(id);

    const run = phonePing(lab, s().network)!;
    useStore.setState({ terminalDeviceId: run.fromId });
    s().runTerminal(`ping ${run.toIp}`);
    // The packet lands — the one moment a lab would normally complete.
    if (s().packet) s().packetArrived(s().packet!.id);

    expect(s().xp).toBe(0);
    expect(s().earnedBadges).toEqual([]);
    expect(s().completedLabs).toEqual([]);
    expect(s().labProgress).toEqual({});
    expect(s().justCompleted).toBeNull();
    expect(s().verifyStatus).toBe('none');
  });

  it.each(cases)('prints %s’s ping to the terminal and sends a packet', (id, lab) => {
    startOnDesktop(TIER0);
    s().loadPhoneLab(id);
    const before = s().terminalLog.length;

    const run = phonePing(lab, s().network)!;
    useStore.setState({ terminalDeviceId: run.fromId });
    s().runTerminal(`ping ${run.toIp}`);

    expect(s().terminalLog.length).toBeGreaterThan(before);
    expect(s().terminalLog.some((l) => l.text.includes(`ping ${run.toIp}`))).toBe(true);
    expect(s().terminalLog.some((l) => l.cls === 'ok')).toBe(true);
    // Something for the canvas to animate, along the path the engine returned.
    expect(s().packet).not.toBeNull();
    expect(s().packet!.success).toBe(true);
    expect(s().packet!.path[0]).toBe(run.fromId);
    // Never the verifying burst: that is a lab being signed off, which this
    // canvas is not allowed to do.
    expect(s().packet!.verify).toBe(false);
  });

  it('leaves the proven path pulsing once the packet lands', () => {
    startOnDesktop(TIER0);
    s().loadPhoneLab(TIER0);
    const lab = ALL_LABS.find((l) => l.id === TIER0)!;
    const run = phonePing(lab, s().network)!;
    useStore.setState({ terminalDeviceId: run.fromId });
    s().runTerminal(`ping ${run.toIp}`);
    s().packetArrived(s().packet!.id);

    expect(s().ambientPath).not.toBeNull();
    expect(s().packet).toBeNull();
  });

  it('is exclusive with Learn Topology — they share one canvas', () => {
    startOnDesktop(TIER0);
    s().enterTopologyMode();
    s().loadTopology('star');
    expect(s().topologyMode).toBe(true);

    s().loadPhoneLab(TIER0);
    expect(s().topologyMode).toBe(false);
    expect(s().topologyId).toBeNull();

    s().enterTopologyMode();
    expect(s().phoneMode).toBe(false);
    expect(s().phoneLabId).toBeNull();
  });
});

describe('leaving the phone layout', () => {
  it('hands the canvas back to the lab the player was playing', () => {
    startOnDesktop(TIER0);
    s().loadPhoneLab(TIER2);
    s().exitPhoneMode();

    expect(s().phoneMode).toBe(false);
    expect(s().phoneLabId).toBeNull();
    expect(s().activeLabId).toBe(TIER0);
    // Broken again, exactly as the lab authored it — and graded again.
    expect(s().network).toEqual(ALL_LABS.find((l) => l.id === TIER0)!.initialState);
    expect(s().objectiveResults.length).toBe(3);
    expect(s().objectiveResults.every((o) => o.complete)).toBe(false);
  });

  it('grades normally again once the desktop has the canvas back', () => {
    startOnDesktop(TIER0);
    s().loadPhoneLab(TIER0);
    s().exitPhoneMode();

    const { setIfaceField } = s();
    setIfaceField('pc1', 'e0', 'ip', '192.168.1.10');
    setIfaceField('pc1', 'e0', 'mask', '255.255.255.0');
    setIfaceField('pc2', 'e0', 'ip', '192.168.1.11');
    setIfaceField('pc2', 'e0', 'mask', '255.255.255.0');

    expect(s().objectiveResults.every((o) => o.complete)).toBe(true);
    // Still gated on the student's own verifying ping, exactly as before.
    expect(s().verifyStatus).toBe('ready');
  });

  it('opening a lab on the desktop leaves phone mode behind', () => {
    startOnDesktop(TIER0);
    s().loadPhoneLab(TIER2);
    s().loadLab(TIER2);

    expect(s().phoneMode).toBe(false);
    expect(s().phoneLabId).toBeNull();
    expect(s().network).toEqual(ALL_LABS.find((l) => l.id === TIER2)!.initialState);
  });
});

describe('the tap-only canvas', () => {
  // The phone fits the whole layout to the screen with the viewBox alone, so a
  // device outside that box is a device nobody on a phone can see or tap.
  it.each(cases)('%s fits every device inside the viewBox', (_id, lab) => {
    const net = solveLab(lab);
    const b = canvasBounds(net);
    for (const d of net.devices) {
      expect(d.x, `${d.label} left`).toBeGreaterThanOrEqual(b.x);
      expect(d.y, `${d.label} top`).toBeGreaterThanOrEqual(b.y);
      expect(d.x + NODE_W, `${d.label} right`).toBeLessThanOrEqual(b.x + b.w);
      // Plus the two lines of text printed under the box.
      expect(d.y + BOX_H, `${d.label} bottom`).toBeLessThanOrEqual(b.y + b.h);
    }
  });

  it.each(cases)('%s leaves room under the last box for its label', (_id, lab) => {
    const net = solveLab(lab);
    const b = canvasBounds(net);
    const lowest = Math.max(...net.devices.map((d) => d.y + BOX_H));
    // The name and address are drawn below the box; the box's own bottom edge
    // sitting on the boundary would clip them.
    expect(b.y + b.h - lowest).toBeGreaterThan(34);
  });

  it('survives an empty canvas', () => {
    const b = canvasBounds({ devices: [], links: [] });
    expect(b.w).toBeGreaterThan(0);
    expect(b.h).toBeGreaterThan(0);
  });
});

describe('the breakpoint', () => {
  it('is 900px, and the phone layout is strictly below it', () => {
    expect(PHONE_BREAKPOINT).toBe(900);
    // Fractional, so a viewport on a half-pixel (zoom, scaled device) still
    // matches one layout or the other rather than neither.
    expect(PHONE_MEDIA_QUERY).toBe('(max-width: 899.98px)');
  });
});
