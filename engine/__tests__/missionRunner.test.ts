import { describe, it, expect } from 'vitest';
import type { Lab, NetworkState, Predicate } from '../types.js';
import {
  checkPredicate,
  evaluateObjectives,
  isLabComplete,
  isVerifyPing,
  labStatus,
  runLab,
  verifyTargetIp,
} from '../missionRunner.js';

function state(): NetworkState {
  return {
    devices: [
      {
        id: 'pc1',
        kind: 'pc',
        label: 'PC1',
        powered: true,
        x: 0,
        y: 0,
        interfaces: [{ id: 'e0', name: 'eth0', ip: '192.168.1.10', mask: '255.255.255.0', linkId: 'l1' }],
      },
      {
        id: 'r1',
        kind: 'router',
        label: 'R1',
        powered: true,
        x: 0,
        y: 0,
        routes: [{ dst: '20.0.0.0', mask: '255.255.255.0', gateway: '172.16.0.2' }],
        interfaces: [{ id: 'g0', name: 'ether1', ip: '10.0.0.1', mask: '255.255.255.0', linkId: 'l0' }],
      },
    ],
    links: [],
  };
}

describe('checkPredicate — ifaceHasIp', () => {
  it('matches ip and mask', () => {
    expect(
      checkPredicate(state(), { type: 'ifaceHasIp', device: 'pc1', iface: 'e0', ip: '192.168.1.10', mask: '255.255.255.0' }),
    ).toBe(true);
  });

  it('fails on wrong mask', () => {
    expect(
      checkPredicate(state(), { type: 'ifaceHasIp', device: 'pc1', iface: 'e0', ip: '192.168.1.10', mask: '255.255.255.128' }),
    ).toBe(false);
  });

  it('ignores mask when the predicate omits it', () => {
    expect(
      checkPredicate(state(), { type: 'ifaceHasIp', device: 'pc1', iface: 'e0', ip: '192.168.1.10' }),
    ).toBe(true);
  });

  it('fails on unknown device or iface', () => {
    expect(checkPredicate(state(), { type: 'ifaceHasIp', device: 'nope', iface: 'e0', ip: '192.168.1.10' })).toBe(false);
    expect(checkPredicate(state(), { type: 'ifaceHasIp', device: 'pc1', iface: 'nope', ip: '192.168.1.10' })).toBe(false);
  });
});

// --- The open-ended address objective ---------------------------------------

/** Hosts on one segment, addressed (or not) by the caller — the shape an
 *  objective that lets the student pick their own address is written against. */
function hosts(...addrs: Array<{ ip?: string | null; mask?: string | null }>): NetworkState {
  return {
    devices: addrs.map((a, i) => ({
      id: `pc${i + 1}`,
      kind: 'pc' as const,
      label: `PC${i + 1}`,
      powered: true,
      x: 0,
      y: 0,
      interfaces: [
        { id: 'e0', name: 'eth0', ip: a.ip ?? null, mask: a.mask ?? null, linkId: `l${i}` },
      ],
    })),
    links: [],
  };
}

const onSlash24 = (device: string) =>
  ({
    type: 'ifaceInNetwork',
    device,
    iface: 'e0',
    network: '192.168.1.0',
    mask: '255.255.255.0',
  }) as const;

describe('checkPredicate — ifaceInNetwork', () => {
  const slash24 = '255.255.255.0';

  it('accepts any usable host address inside the network', () => {
    // The lab names the network; which host address is the student's call.
    for (const ip of ['192.168.1.1', '192.168.1.10', '192.168.1.50', '192.168.1.254']) {
      expect(checkPredicate(hosts({ ip, mask: slash24 }), onSlash24('pc1')), ip).toBe(true);
    }
  });

  it('rejects an address outside the network', () => {
    for (const ip of ['192.168.2.10', '10.0.0.10', '192.168.0.255']) {
      expect(checkPredicate(hosts({ ip, mask: slash24 }), onSlash24('pc1')), ip).toBe(false);
    }
  });

  it('rejects the network and broadcast addresses', () => {
    // Both are inside the /24 and neither is a host: .0 names the network itself
    // and .255 reaches everyone on it.
    expect(checkPredicate(hosts({ ip: '192.168.1.0', mask: slash24 }), onSlash24('pc1'))).toBe(false);
    expect(checkPredicate(hosts({ ip: '192.168.1.255', mask: slash24 }), onSlash24('pc1'))).toBe(false);
  });

  it('rejects an address a second interface already carries', () => {
    // An address conflict is not two solved objectives — neither host passes.
    const clash = hosts({ ip: '192.168.1.10', mask: slash24 }, { ip: '192.168.1.10', mask: slash24 });
    expect(checkPredicate(clash, onSlash24('pc1'))).toBe(false);
    expect(checkPredicate(clash, onSlash24('pc2'))).toBe(false);

    // Move one of them and both are fine again.
    const apart = hosts({ ip: '192.168.1.10', mask: slash24 }, { ip: '192.168.1.11', mask: slash24 });
    expect(checkPredicate(apart, onSlash24('pc1'))).toBe(true);
    expect(checkPredicate(apart, onSlash24('pc2'))).toBe(true);
  });

  it('rejects a mask other than the one the lab named', () => {
    // 192.168.1.10/25 is a host on a different network than the objective means.
    expect(checkPredicate(hosts({ ip: '192.168.1.10', mask: '255.255.255.128' }), onSlash24('pc1')))
      .toBe(false);
    expect(checkPredicate(hosts({ ip: '192.168.1.10', mask: null }), onSlash24('pc1'))).toBe(false);
  });

  it('rejects an unconfigured interface, and an unknown device or iface', () => {
    expect(checkPredicate(hosts({}), onSlash24('pc1'))).toBe(false);
    expect(checkPredicate(hosts({ ip: '192.168.1.10', mask: slash24 }), onSlash24('nope'))).toBe(false);
    expect(
      checkPredicate(hosts({ ip: '192.168.1.10', mask: slash24 }), {
        ...onSlash24('pc1'),
        iface: 'nope',
      }),
    ).toBe(false);
  });

  it('has no network or broadcast address to reserve on a /31', () => {
    // RFC 3021: both addresses of a /31 point-to-point link are usable.
    const p31 = {
      type: 'ifaceInNetwork',
      device: 'pc1',
      iface: 'e0',
      network: '10.0.0.0',
      mask: '255.255.255.254',
    } as const;
    expect(checkPredicate(hosts({ ip: '10.0.0.0', mask: '255.255.255.254' }), p31)).toBe(true);
    expect(checkPredicate(hosts({ ip: '10.0.0.1', mask: '255.255.255.254' }), p31)).toBe(true);
  });
});

describe('checkPredicate — canPing by device', () => {
  it('is false while the named device has no address, rather than throwing', () => {
    expect(checkPredicate(hosts({ ip: '192.168.1.10', mask: '255.255.255.0' }, {}), {
      type: 'canPing',
      from: 'pc1',
      toDevice: 'pc2',
    })).toBe(false);
  });

  it('is false when the predicate names no destination at all', () => {
    // `validatePredicate` rejects this at load; a lab assembled in code still
    // reads as "not reachable" rather than pinging `undefined`.
    const noTarget = { type: 'canPing', from: 'pc1' } as unknown as Predicate;
    expect(checkPredicate(hosts({ ip: '192.168.1.10', mask: '255.255.255.0' }), noTarget)).toBe(false);
  });
});

describe('checkPredicate — hasRoute', () => {
  const route = (over: Partial<{ device: string; dst: string; mask: string; gateway: string }> = {}) =>
    ({ type: 'hasRoute', device: 'r1', dst: '20.0.0.0', mask: '255.255.255.0', gateway: '172.16.0.2', ...over }) as const;

  it('matches an existing route by dst, mask and gateway', () => {
    expect(checkPredicate(state(), route())).toBe(true);
  });

  it('fails on wrong gateway or missing route', () => {
    expect(checkPredicate(state(), route({ gateway: '9.9.9.9' }))).toBe(false);
    expect(checkPredicate(state(), route({ dst: '30.0.0.0' }))).toBe(false);
    expect(checkPredicate(state(), route({ device: 'pc1' }))).toBe(false);
  });

  it('fails on the right destination with the wrong prefix length', () => {
    // 20.0.0.0/8 is not the /24 the objective asks for: it swallows far more of
    // the address space than the lab intends, so it must not count as the answer.
    expect(checkPredicate(state(), route({ mask: '255.0.0.0' }))).toBe(false);
    expect(checkPredicate(state(), route({ mask: '255.255.255.128' }))).toBe(false);
  });
});

describe('checkPredicate — fidelity-B predicates (commandRun / answerEquals)', () => {
  it('commandRun matches a regex against terminal history', () => {
    const p = { type: 'commandRun', matches: 'nmap\\s+-sn' } as const;
    expect(checkPredicate(state(), p, { commandHistory: ['ip addr', 'nmap -sn 10.0.0.0/24'] })).toBe(true);
    expect(checkPredicate(state(), p, { commandHistory: ['ping 10.0.0.1'] })).toBe(false);
    expect(checkPredicate(state(), p)).toBe(false); // no history
  });

  it('answerEquals compares submitted answers', () => {
    const p = { type: 'answerEquals', key: 'liveHost', value: '10.0.0.7' } as const;
    expect(checkPredicate(state(), p, { answers: { liveHost: '10.0.0.7' } })).toBe(true);
    expect(checkPredicate(state(), p, { answers: { liveHost: '10.0.0.9' } })).toBe(false);
  });
});

describe('checkPredicate — unknown predicate type', () => {
  it('throws rather than returning undefined', () => {
    // Falling through the switch used to yield `undefined`, which reads as "not
    // met yet" — an objective stuck grey forever with nothing to point at.
    const bogus = { type: 'hasFirewallRule', device: 'fw1' } as unknown as Predicate;
    expect(() => checkPredicate(state(), bogus)).toThrow(/unknown predicate type "hasFirewallRule"/);
  });

  it('names the types it does know, so the author can see the typo', () => {
    const typo = { type: 'ifaceHasIP', device: 'pc1', iface: 'e0', ip: '192.168.1.10' } as unknown as Predicate;
    expect(() => checkPredicate(state(), typo)).toThrow(/ifaceHasIp/);
  });
});

describe('objective aggregation', () => {
  const lab: Lab = {
    id: 'test',
    tier: 0,
    mode: 'learn',
    fidelity: 'A',
    title: 'T',
    brief: 'b',
    initialState: { devices: [], links: [] },
    objectives: [
      { id: 'o1', description: 'PC1 addressed', check: { type: 'ifaceHasIp', device: 'pc1', iface: 'e0', ip: '192.168.1.10' } },
      { id: 'o2', description: 'R1 route', check: { type: 'hasRoute', device: 'r1', dst: '20.0.0.0', mask: '255.255.255.0', gateway: '172.16.0.2' } },
      { id: 'o3', description: 'impossible', check: { type: 'hasRoute', device: 'r1', dst: '99.0.0.0', mask: '255.255.255.0', gateway: '172.16.0.2' } },
    ],
    hints: [],
    rewards: { xp: 10 },
  };

  it('evaluateObjectives reports each objective', () => {
    const results = evaluateObjectives(state(), lab.objectives);
    expect(results.map((r) => r.complete)).toEqual([true, true, false]);
  });

  it('isLabComplete is false while any objective fails', () => {
    expect(isLabComplete(state(), lab)).toBe(false);
  });

  it('runLab withholds rewards until every objective passes', () => {
    const partial = runLab(state(), lab);
    expect(partial.complete).toBe(false);
    expect(partial.rewards).toBeUndefined();

    const solvable: Lab = { ...lab, objectives: lab.objectives.slice(0, 2) };
    const done = runLab(state(), solvable);
    expect(done.complete).toBe(true);
    expect(done.rewards).toEqual({ xp: 10 });
  });
});

// --- Verifying ping: the gate between green objectives and a finished lab ----

describe('labStatus — the completion gate', () => {
  const objectives = (...done: boolean[]) =>
    done.map((complete, i) => ({ id: `o${i}`, description: '', complete }));

  const plain: Lab = {
    id: 'plain',
    tier: 0,
    mode: 'learn',
    fidelity: 'A',
    title: 'T',
    brief: 'b',
    initialState: { devices: [], links: [] },
    objectives: [],
    hints: [],
    rewards: { xp: 10 },
  };
  const verified: Lab = { ...plain, id: 'verified', verify: { from: 'pc1', toIp: '10.0.0.2' } };

  it('is incomplete while any objective fails, verified or not', () => {
    expect(labStatus(objectives(true, false), plain)).toBe('incomplete');
    expect(labStatus(objectives(true, false), verified, true)).toBe('incomplete');
  });

  it('a lab with no verifying ping completes on objectives alone', () => {
    expect(labStatus(objectives(true, true), plain)).toBe('complete');
  });

  it('a lab with one parks on green objectives until the ping lands', () => {
    expect(labStatus(objectives(true, true), verified)).toBe('awaiting-verification');
    expect(labStatus(objectives(true, true), verified, true)).toBe('complete');
  });

  it('runLab withholds rewards through awaiting-verification', () => {
    const lab: Lab = {
      ...verified,
      objectives: [
        { id: 'o1', description: 'PC1 addressed', check: { type: 'ifaceHasIp', device: 'pc1', iface: 'e0', ip: '192.168.1.10' } },
      ],
    };
    const unverified = runLab(state(), lab);
    expect(unverified.status).toBe('awaiting-verification');
    expect(unverified.complete).toBe(false);
    expect(unverified.rewards).toBeUndefined();

    const done = runLab(state(), lab, {}, true);
    expect(done.status).toBe('complete');
    expect(done.rewards).toEqual({ xp: 10 });
  });

  it('isVerifyPing matches only the declared source and destination', () => {
    expect(isVerifyPing(verified, 'pc1', '10.0.0.2', state())).toBe(true);
    expect(isVerifyPing(verified, 'pc2', '10.0.0.2', state())).toBe(false); // wrong shell
    expect(isVerifyPing(verified, 'pc1', '10.0.0.3', state())).toBe(false); // wrong target
    expect(isVerifyPing(plain, 'pc1', '10.0.0.2', state())).toBe(false); // declares none
  });
});

// --- A sign-off ping aimed at a device, not an address ----------------------

describe('verifyTargetIp — a destination the student chose', () => {
  const base: Lab = {
    id: 'base',
    tier: 0,
    mode: 'learn',
    fidelity: 'A',
    title: 'T',
    brief: 'b',
    initialState: { devices: [], links: [] },
    objectives: [],
    hints: [],
    rewards: { xp: 10 },
  };
  const pinned: Lab = { ...base, verify: { from: 'r1', toIp: '10.0.0.2' } };
  const byDevice: Lab = { ...base, verify: { from: 'r1', toDevice: 'pc1' } };

  it('hands back the literal address when the lab pins one', () => {
    expect(verifyTargetIp(pinned, state())).toBe('10.0.0.2');
  });

  it('resolves a named device to whatever address it currently carries', () => {
    expect(verifyTargetIp(byDevice, state())).toBe('192.168.1.10');

    // The whole point: re-address the target and the sign-off ping follows it,
    // rather than staying pointed at an address the author guessed.
    const moved = state();
    moved.devices[0].interfaces[0].ip = '192.168.1.77';
    expect(verifyTargetIp(byDevice, moved)).toBe('192.168.1.77');
    expect(isVerifyPing(byDevice, 'r1', '192.168.1.77', moved)).toBe(true);
    expect(isVerifyPing(byDevice, 'r1', '192.168.1.10', moved)).toBe(false);
  });

  it('resolves to nothing while the target is unaddressed, or has no verify', () => {
    const bare = state();
    bare.devices[0].interfaces[0].ip = null;
    expect(verifyTargetIp(byDevice, bare)).toBeUndefined();
    expect(isVerifyPing(byDevice, 'r1', '192.168.1.10', bare)).toBe(false);
    expect(verifyTargetIp(base, state())).toBeUndefined();
  });
});
