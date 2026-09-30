/**
 * End-to-end tests against the three real §13 mission JSON files. These walk the
 * §11 acceptance criteria: each "student action" mutates a fresh clone of the
 * lab's initialState, and we assert the objectives flip exactly as specified.
 */

import { describe, it, expect } from 'vitest';
import type { Device, Lab, NetworkState, Predicate } from '../types.js';
import { isHostAddress } from '../ip.js';
import { ping } from '../simulate.js';
import { evaluateObjectives, isLabComplete, verifyTargetIp } from '../missionRunner.js';
import { PREDICATE_TYPES, validateLab } from '../validate.js';
import { labs, labsById, tier0FirstPing, tier1FixMask, tier2StaticRoute } from '../labs/index.js';

function freshState(lab: Lab): NetworkState {
  // Deep clone so each test mutates an isolated copy of the lab's initial state.
  return JSON.parse(JSON.stringify(lab.initialState)) as NetworkState;
}

function device(state: NetworkState, id: string): Device {
  const d = state.devices.find((dev) => dev.id === id);
  if (!d) throw new Error(`no device ${id} in test state`);
  return d;
}

function setIp(state: NetworkState, deviceId: string, ifaceId: string, ip: string, mask: string) {
  const iface = device(state, deviceId).interfaces.find((i) => i.id === ifaceId)!;
  iface.ip = ip;
  iface.mask = mask;
}

function addRoute(state: NetworkState, deviceId: string, dst: string, mask: string, gateway: string) {
  const d = device(state, deviceId);
  d.routes = d.routes ?? [];
  d.routes.push({ dst, mask, gateway });
}

function complete(results: { complete: boolean }[]): boolean[] {
  return results.map((r) => r.complete);
}

// --- Registry sanity -------------------------------------------------------

describe('lab registry', () => {
  it('exposes the three MVP missions keyed by id', () => {
    expect(labs).toHaveLength(3);
    expect(Object.keys(labsById).sort()).toEqual(
      ['tier0-first-ping.learn', 'tier1-fix-mask.learn', 'tier2-static-route.learn'],
    );
  });

  it('every lab conforms structurally to the Lab schema', () => {
    for (const lab of labs) {
      expect(typeof lab.id).toBe('string');
      expect([0, 1, 2, 3, 4, 5]).toContain(lab.tier);
      expect(['learn', 'practice', 'master']).toContain(lab.mode);
      expect(['A', 'B']).toContain(lab.fidelity);
      expect(lab.objectives.length).toBeGreaterThan(0);
      expect(lab.rewards.xp).toBeGreaterThan(0);
      for (const o of lab.objectives) {
        expect(o).toHaveProperty('id');
        expect(o).toHaveProperty('check.type');
      }
    }
  });

  it('every objective checks a predicate type the engine implements', () => {
    // A type the switch in checkPredicate doesn't handle is an objective that can
    // never complete. The engine throws on one now; this catches it at test time,
    // before a student meets an unwinnable lab.
    for (const lab of labs) {
      for (const o of lab.objectives) {
        expect(PREDICATE_TYPES, `${lab.id} objective ${o.id} checks an unknown predicate type`)
          .toContain(o.check.type);
      }
    }
  });

  it('every lab passes schema validation', () => {
    // The registry already validates on import, so this is a belt-and-braces
    // check that stays honest if a lab is ever loaded some other way.
    for (const lab of labs) {
      expect(() => validateLab(lab), `${lab.id} fails schema validation`).not.toThrow();
    }
  });

  it('unlock targets reference real labs or forward stubs', () => {
    // tier0 unlocks tier1, tier1 unlocks tier2 — the ramp is wired.
    expect(tier0FirstPing.rewards.unlocks).toContain('tier1-fix-mask.learn');
    expect(tier1FixMask.rewards.unlocks).toContain('tier2-static-route.learn');
  });
});

// --- Mission 1: First Contact ---------------------------------------------

describe('Mission 1 — First Contact (build from empty, get a green ping)', () => {
  it('starts with unconfigured PCs and no objectives met', () => {
    const state = freshState(tier0FirstPing);
    expect(complete(evaluateObjectives(state, tier0FirstPing.objectives))).toEqual([false, false, false]);
  });

  it('configuring both PCs on 192.168.1.0/24 completes the lab and enables the ping', () => {
    const state = freshState(tier0FirstPing);
    setIp(state, 'pc1', 'e0', '192.168.1.10', '255.255.255.0');
    setIp(state, 'pc2', 'e0', '192.168.1.11', '255.255.255.0');

    const results = evaluateObjectives(state, tier0FirstPing.objectives);
    expect(complete(results)).toEqual([true, true, true]);
    expect(isLabComplete(state, tier0FirstPing)).toBe(true);
  });

  it('addressing only PC1 leaves the ping objective failing', () => {
    const state = freshState(tier0FirstPing);
    setIp(state, 'pc1', 'e0', '192.168.1.10', '255.255.255.0');
    expect(complete(evaluateObjectives(state, tier0FirstPing.objectives))).toEqual([true, false, false]);
  });
});

// --- Mission 1, reopened: the addresses are the student's to choose ---------

describe('Mission 1 — the student picks the host addresses', () => {
  /** Address both PCs on the /24 and report how the three objectives stand. */
  function solveWith(state: NetworkState, pc1: string, pc2: string): boolean[] {
    setIp(state, 'pc1', 'e0', pc1, '255.255.255.0');
    setIp(state, 'pc2', 'e0', pc2, '255.255.255.0');
    return complete(evaluateObjectives(state, tier0FirstPing.objectives));
  }

  it('accepts any two different host addresses on the network', () => {
    // Nothing in the lab names .10 and .11 any more — these are all solutions,
    // and the sign-off ping follows whichever the student picked.
    const solutions: Array<[string, string]> = [
      ['192.168.1.10', '192.168.1.11'],
      ['192.168.1.1', '192.168.1.254'],
      ['192.168.1.200', '192.168.1.7'],
    ];
    for (const [a, b] of solutions) {
      const state = freshState(tier0FirstPing);
      expect(solveWith(state, a, b), `${a} / ${b} should solve the lab`).toEqual([true, true, true]);
      expect(isLabComplete(state, tier0FirstPing)).toBe(true);
      expect(verifyTargetIp(tier0FirstPing, state)).toBe(b);
    }
  });

  it('rejects an address outside the network', () => {
    const state = freshState(tier0FirstPing);
    // Right mask, wrong network: PC2's objective fails and so does the ping,
    // because a remote destination needs a gateway PC1 hasn't got.
    expect(solveWith(state, '192.168.1.10', '192.168.2.11')).toEqual([true, false, false]);
    expect(isLabComplete(state, tier0FirstPing)).toBe(false);
  });

  it('rejects the same address on both PCs', () => {
    const state = freshState(tier0FirstPing);
    // An address conflict, not two solved objectives — neither PC passes, and
    // the frame has nowhere unambiguous to go.
    expect(solveWith(state, '192.168.1.10', '192.168.1.10')).toEqual([false, false, false]);
    expect(isLabComplete(state, tier0FirstPing)).toBe(false);
  });

  it('rejects the network and broadcast addresses', () => {
    // The objective and the simulator agree: a host on .0 or .255 cannot send,
    // so the ping objective fails alongside the address one rather than going
    // green over a config no real hardware would bring up.
    const network = freshState(tier0FirstPing);
    expect(solveWith(network, '192.168.1.0', '192.168.1.11')).toEqual([false, true, false]);
    expect(isLabComplete(network, tier0FirstPing)).toBe(false);

    const broadcast = freshState(tier0FirstPing);
    expect(solveWith(broadcast, '192.168.1.255', '192.168.1.11')).toEqual([false, true, false]);
    expect(isLabComplete(broadcast, tier0FirstPing)).toBe(false);

    // And on the far side: pinging PC2 now reads as a broadcast to the whole
    // segment, which PC2 receives and then cannot answer from .255.
    const both = freshState(tier0FirstPing);
    expect(solveWith(both, '192.168.1.10', '192.168.1.255')).toEqual([true, false, false]);
    expect(isLabComplete(both, tier0FirstPing)).toBe(false);
  });
});

// --- Mission 2: The Silent PC (fix the mask) -------------------------------

describe('Mission 2 — The Silent PC (starts broken, fixing the mask flips it)', () => {
  it('starts broken: the ping objective fails while PC2 is a /25', () => {
    const state = freshState(tier1FixMask);
    const results = evaluateObjectives(state, tier1FixMask.objectives);
    // o1 (correct mask) fails, o2 (canPing) fails.
    expect(complete(results)).toEqual([false, false]);
  });

  it('correcting PC2 mask to /24 flips both objectives to complete', () => {
    const state = freshState(tier1FixMask);
    setIp(state, 'pc2', 'e0', '192.168.1.11', '255.255.255.0');
    const results = evaluateObjectives(state, tier1FixMask.objectives);
    expect(complete(results)).toEqual([true, true]);
    expect(isLabComplete(state, tier1FixMask)).toBe(true);
  });
});

// --- Mission 3: Two Islands, One Bridge (two static routes) ----------------

describe('Mission 3 — Two Islands (needs two correct static routes)', () => {
  it('starts with no routes and no cross-network reachability', () => {
    const state = freshState(tier2StaticRoute);
    expect(complete(evaluateObjectives(state, tier2StaticRoute.objectives))).toEqual([false, false, false]);
  });

  it('one route is not enough — partial config gives a precise failure reason', () => {
    const state = freshState(tier2StaticRoute);
    addRoute(state, 'r1', '20.0.0.0', '255.255.255.0', '172.16.0.2');
    const results = evaluateObjectives(state, tier2StaticRoute.objectives);
    // o1 met, o2 (mirror route) not met, o3 (ping) not met — reply can't return.
    expect(complete(results)).toEqual([true, false, false]);
  });

  it('both mirror routes complete the lab and the end-to-end ping', () => {
    const state = freshState(tier2StaticRoute);
    addRoute(state, 'r1', '20.0.0.0', '255.255.255.0', '172.16.0.2');
    addRoute(state, 'r2', '10.0.0.0', '255.255.255.0', '172.16.0.1');
    const results = evaluateObjectives(state, tier2StaticRoute.objectives);
    expect(complete(results)).toEqual([true, true, true]);
    expect(isLabComplete(state, tier2StaticRoute)).toBe(true);
  });

  it('a wrong prefix length on an otherwise-correct route does not satisfy the objective', () => {
    const state = freshState(tier2StaticRoute);
    addRoute(state, 'r1', '20.0.0.0', '255.0.0.0', '172.16.0.2'); // /8, not the /24 asked for
    addRoute(state, 'r2', '10.0.0.0', '255.255.255.0', '172.16.0.1');
    const results = evaluateObjectives(state, tier2StaticRoute.objectives);
    expect(results[0].complete).toBe(false); // the objective names 20.0.0.0/24
    expect(isLabComplete(state, tier2StaticRoute)).toBe(false);
  });

  it('a wrong gateway on an otherwise-correct route does not satisfy the objective', () => {
    const state = freshState(tier2StaticRoute);
    addRoute(state, 'r1', '20.0.0.0', '255.255.255.0', '9.9.9.9'); // typo'd next hop
    addRoute(state, 'r2', '10.0.0.0', '255.255.255.0', '172.16.0.1');
    const results = evaluateObjectives(state, tier2StaticRoute.objectives);
    expect(results[0].complete).toBe(false); // hasRoute wants gateway 172.16.0.2
    expect(results[2].complete).toBe(false); // and the ping can't get out of R1
  });
});

// --- Sign-off pings ---------------------------------------------------------

describe('verifying pings', () => {
  it('every mission names the ping it is signed off with', () => {
    for (const lab of labs) {
      expect(lab.verify, `${lab.id} declares no verifying ping`).toBeDefined();
      const from = lab.initialState.devices.find((d) => d.id === lab.verify!.from);
      expect(from, `${lab.id} verify.from is not a device in the lab`).toBeDefined();

      // A device named as the destination has to be one the lab actually has,
      // or the sign-off ping resolves to nothing and the lab never finishes.
      const toDevice = lab.verify!.toDevice;
      if (toDevice) {
        expect(
          lab.initialState.devices.find((d) => d.id === toDevice),
          `${lab.id} verify.toDevice is not a device in the lab`,
        ).toBeDefined();
      }
    }
  });

  it('the declared ping is the same one the lab already checks as an objective', () => {
    // The sign-off run has to prove the lab's own claim — otherwise a student
    // could verify one thing while the objectives assert another. Compared as
    // declared, so a lab naming its destination by device has to do so in both.
    for (const lab of labs) {
      const canPing = lab.objectives
        .map((o) => o.check)
        .find((c): c is Extract<Predicate, { type: 'canPing' }> => c.type === 'canPing');
      expect(canPing, `${lab.id} has no canPing objective`).toBeDefined();
      const v = lab.verify!;
      expect({ from: v.from, toIp: v.toIp, toDevice: v.toDevice }, lab.id).toEqual({
        from: canPing!.from,
        toIp: canPing!.toIp,
        toDevice: canPing!.toDevice,
      });
    }
  });
});

// --- Every shipped lab, against the non-host address rule -------------------

describe('shipped labs and non-host addresses', () => {
  it('no lab starts a device on its own network or broadcast address', () => {
    // An interface on .0 or .255 now refuses to send at all. That is the right
    // answer for a typo and the wrong one for a lab that means to ship the fault
    // as the puzzle — so if a future lab does that deliberately, it gets listed
    // here on purpose rather than failing in a student's face.
    for (const lab of labs) {
      for (const device of lab.initialState.devices) {
        for (const iface of device.interfaces) {
          if (!iface.ip || !iface.mask) continue;
          expect(
            isHostAddress(iface.ip, iface.mask),
            `${lab.id}: ${device.label} ${iface.name} starts on ${iface.ip} / ${iface.mask}, which is not a host address`,
          ).toBe(true);
        }
      }
    }
  });

  it('every lab is still solvable end to end, broadcast rules and all', () => {
    // The sign-off ping of each lab, on a solved copy of its own state. This is
    // the guard that the new source/destination checks did not quietly break a
    // mission that used to pass.
    const solved: Array<[string, (net: NetworkState) => void]> = [
      [
        'tier0-first-ping.learn',
        (net) => {
          setIp(net, 'pc1', 'e0', '192.168.1.10', '255.255.255.0');
          setIp(net, 'pc2', 'e0', '192.168.1.11', '255.255.255.0');
        },
      ],
      ['tier1-fix-mask.learn', (net) => setIp(net, 'pc2', 'e0', '192.168.1.11', '255.255.255.0')],
      [
        'tier2-static-route.learn',
        (net) => {
          addRoute(net, 'r1', '20.0.0.0', '255.255.255.0', '172.16.0.2');
          addRoute(net, 'r2', '10.0.0.0', '255.255.255.0', '172.16.0.1');
        },
      ],
    ];

    for (const [labId, mutate] of solved) {
      const lab = labsById[labId];
      const state = freshState(lab);
      mutate(state);

      expect(complete(evaluateObjectives(state, lab.objectives)), labId).toEqual(
        lab.objectives.map(() => true),
      );

      const target = verifyTargetIp(lab, state)!;
      const run = ping(state, lab.verify!.from, target);
      expect(run.success, `${labId} sign-off ping should land`).toBe(true);
      // And it is a plain unicast, not something the broadcast path swallowed.
      expect(run.broadcast, `${labId} sign-off ping should be a unicast`).toBeUndefined();
    }
  });
});
