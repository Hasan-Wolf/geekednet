/**
 * Lab schema validation. Every case here is a lab that would otherwise load fine
 * and hand a student an objective they cannot complete, however correctly they
 * configure the network.
 */

import { describe, it, expect } from 'vitest';
import { LabSchemaError, PREDICATE_TYPES, validateLab, validatePredicate } from '../validate.js';

/** A minimal well-formed lab; each test breaks exactly one thing in it. */
function lab(check: unknown) {
  return {
    id: 'test-lab',
    tier: 0,
    mode: 'learn',
    fidelity: 'A',
    title: 'T',
    brief: 'b',
    initialState: { devices: [], links: [] },
    objectives: [{ id: 'o1', description: 'does a thing', check }],
    hints: [],
    rewards: { xp: 10 },
  };
}

describe('validatePredicate — well-formed predicates', () => {
  it('accepts each predicate type the engine implements', () => {
    const fine: unknown[] = [
      { type: 'canPing', from: 'pc1', toIp: '192.168.1.11' },
      { type: 'canPing', from: 'pc1', toDevice: 'pc2' }, // destination named by device
      { type: 'ifaceHasIp', device: 'pc1', iface: 'e0', ip: '192.168.1.10', mask: '255.255.255.0' },
      { type: 'ifaceHasIp', device: 'pc1', iface: 'e0', ip: '192.168.1.10' }, // mask is optional
      { type: 'ifaceInNetwork', device: 'pc1', iface: 'e0', network: '192.168.1.0', mask: '255.255.255.0' },
      { type: 'hasRoute', device: 'r1', dst: '20.0.0.0', mask: '255.255.255.0', gateway: '172.16.0.2' },
      { type: 'commandRun', matches: 'nmap\\s+-sn' },
      { type: 'answerEquals', key: 'liveHost', value: '10.0.0.7' },
    ];
    for (const p of fine) expect(() => validatePredicate(p, 'where')).not.toThrow();
  });

  it('covers every type in the Predicate union', () => {
    expect([...PREDICATE_TYPES].sort()).toEqual(
      ['answerEquals', 'canPing', 'commandRun', 'hasRoute', 'ifaceHasIp', 'ifaceInNetwork'],
    );
  });
});

describe('validatePredicate — exactly one destination', () => {
  it('rejects a canPing that names neither destination', () => {
    // It would evaluate false forever, with nothing in the lab to point at.
    expect(() => validatePredicate({ type: 'canPing', from: 'pc1' }, 'w'))
      .toThrow(/needs exactly one of toIp, toDevice — found neither/);
  });

  it('rejects a canPing that names both', () => {
    // Whichever one the engine honoured, the other would silently do nothing.
    expect(() =>
      validatePredicate({ type: 'canPing', from: 'pc1', toIp: '10.0.0.2', toDevice: 'pc2' }, 'w'),
    ).toThrow(/needs exactly one of toIp, toDevice — found toIp and toDevice/);
  });

  it('still string-checks whichever one is named', () => {
    expect(() => validatePredicate({ type: 'canPing', from: 'pc1', toDevice: null }, 'w'))
      .toThrow(/"toDevice" must be a non-empty string, got null/);
  });
});

describe('validatePredicate — ifaceInNetwork', () => {
  const base = {
    type: 'ifaceInNetwork',
    device: 'pc1',
    iface: 'e0',
    network: '192.168.1.0',
    mask: '255.255.255.0',
  };

  it('requires the mask — without one there is no network to be inside of', () => {
    expect(() =>
      validatePredicate({ type: 'ifaceInNetwork', device: 'pc1', iface: 'e0', network: '192.168.1.0' }, 'w'),
    ).toThrow(/missing required field "mask"/);
  });

  it('rejects a network address or mask the engine cannot parse', () => {
    expect(() => validatePredicate({ ...base, network: '192.168.1' }, 'w'))
      .toThrow(/"network" must be an IPv4 address/);
    expect(() => validatePredicate({ ...base, mask: '255.0.255.0' }, 'w'))
      .toThrow(/contiguous IPv4 subnet mask/);
  });

  it('rejects the fields of its pinned-address sibling', () => {
    // `ip` belongs to ifaceHasIp. Read as "absent" here, it would leave the
    // objective open to an address the author meant to exclude.
    expect(() => validatePredicate({ ...base, ip: '192.168.1.10' }, 'w'))
      .toThrow(/unknown field "ip"/);
  });
});

describe('validatePredicate — null is not "unspecified"', () => {
  it('rejects a null mask instead of demanding an interface with no mask', () => {
    // The bug this exists to stop: `"mask": null` passed a `!== undefined` guard
    // and then required iface.mask to equal null — unsatisfiable through the UI,
    // which always writes a mask string.
    const p = { type: 'ifaceHasIp', device: 'pc1', iface: 'e0', ip: '192.168.1.10', mask: null };
    expect(() => validatePredicate(p, 'lab objective o1')).toThrow(LabSchemaError);
    expect(() => validatePredicate(p, 'lab objective o1')).toThrow(/"mask" must be a non-empty string, got null/);
  });

  it('says to omit the field rather than null it', () => {
    const p = { type: 'ifaceHasIp', device: 'pc1', iface: 'e0', ip: '192.168.1.10', mask: null };
    expect(() => validatePredicate(p, 'w')).toThrow(/omit the field instead/);
  });

  it('rejects empty and whitespace-only strings', () => {
    expect(() => validatePredicate({ type: 'canPing', from: '', toIp: '10.0.0.1' }, 'w')).toThrow(/"from"/);
    expect(() => validatePredicate({ type: 'canPing', from: '  ', toIp: '10.0.0.1' }, 'w')).toThrow(/"from"/);
  });

  it('rejects non-string values', () => {
    expect(() => validatePredicate({ type: 'canPing', from: 'pc1', toIp: 24 }, 'w')).toThrow(/got 24/);
  });
});

describe('validatePredicate — structural errors', () => {
  it('rejects an unknown predicate type, naming the ones it knows', () => {
    const p = { type: 'hasFirewallRule', device: 'fw1' };
    expect(() => validatePredicate(p, 'lab objective o1')).toThrow(
      /unknown predicate type "hasFirewallRule"/,
    );
    expect(() => validatePredicate(p, 'lab objective o1')).toThrow(/known types: .*hasRoute/);
  });

  it('rejects a missing required field', () => {
    expect(() => validatePredicate({ type: 'hasRoute', device: 'r1', dst: '20.0.0.0', gateway: '172.16.0.2' }, 'w'))
      .toThrow(/missing required field "mask"/);
  });

  it('rejects a misspelled field rather than silently ignoring it', () => {
    // `gw` would read as "gateway absent", and absent means unconstrained.
    expect(() => validatePredicate({ type: 'hasRoute', device: 'r1', dst: '20.0.0.0', mask: '255.255.255.0', gw: '172.16.0.2' }, 'w'))
      .toThrow(/unknown field "gw"/);
  });

  it('rejects a check that is not an object', () => {
    expect(() => validatePredicate(null, 'w')).toThrow(/check must be an object, got null/);
    expect(() => validatePredicate('canPing', 'w')).toThrow(/check must be an object/);
  });

  it('prefixes messages with where the predicate lives', () => {
    expect(() => validatePredicate({ type: 'nope' }, 'tier9-x.learn objective o3')).toThrow(
      /^tier9-x\.learn objective o3:/,
    );
  });
});

describe('validatePredicate — addresses, masks and regexes', () => {
  it('rejects an address the engine cannot parse', () => {
    expect(() => validatePredicate({ type: 'canPing', from: 'pc1', toIp: '192.168.1' }, 'w'))
      .toThrow(/"toIp" must be an IPv4 address/);
    expect(() => validatePredicate({ type: 'hasRoute', device: 'r1', dst: '20.0.0.0', mask: '255.255.255.0', gateway: '300.1.1.1' }, 'w'))
      .toThrow(/"gateway" must be an IPv4 address/);
  });

  it('rejects a mask that is malformed or non-contiguous', () => {
    // No student can type a mask that matches these, so the objective is stuck.
    expect(() => validatePredicate({ type: 'ifaceHasIp', device: 'pc1', iface: 'e0', ip: '10.0.0.1', mask: '255.255.255' }, 'w'))
      .toThrow(/contiguous IPv4 subnet mask/);
    expect(() => validatePredicate({ type: 'ifaceHasIp', device: 'pc1', iface: 'e0', ip: '10.0.0.1', mask: '255.0.255.0' }, 'w'))
      .toThrow(/contiguous IPv4 subnet mask/);
    expect(() => validatePredicate({ type: 'ifaceHasIp', device: 'pc1', iface: 'e0', ip: '10.0.0.1', mask: '/24' }, 'w'))
      .toThrow(/contiguous IPv4 subnet mask/);
  });

  it('rejects a commandRun pattern that will not compile', () => {
    // `new RegExp` would otherwise throw mid-evaluation, inside the UI's render.
    expect(() => validatePredicate({ type: 'commandRun', matches: 'nmap (-sn' }, 'w'))
      .toThrow(/must be a valid regular expression/);
  });
});

describe('validateLab', () => {
  it('returns the lab it was given when everything checks out', () => {
    const good = lab({ type: 'canPing', from: 'pc1', toIp: '10.0.0.2' });
    expect(validateLab(good)).toBe(good);
  });

  it('names the lab and objective in the error', () => {
    const broken = lab({ type: 'ifaceHasIp', device: 'pc1', iface: 'e0', ip: '10.0.0.1', mask: null });
    expect(() => validateLab(broken)).toThrow(/^test-lab objective o1: ifaceHasIp predicate field "mask"/);
  });

  it('rejects malformed objectives', () => {
    expect(() => validateLab({ ...lab({ type: 'canPing', from: 'a', toIp: '10.0.0.1' }), objectives: 'none' }))
      .toThrow(/objectives must be an array/);
    expect(() => validateLab({ ...lab(null), objectives: [{ id: 'o1', description: 'd' }] }))
      .toThrow(/check must be an object, got undefined/);
    expect(() => validateLab({ ...lab(null), objectives: [{ description: 'no id', check: { type: 'canPing', from: 'a', toIp: '10.0.0.1' } }] }))
      .toThrow(/objective #0: id must be a non-empty string/);
  });

  it('rejects a sign-off ping that no run of the terminal could match', () => {
    const base = lab({ type: 'canPing', from: 'pc1', toIp: '10.0.0.2' });
    // A lab whose verify never matches parks on green objectives forever.
    expect(() => validateLab({ ...base, verify: { from: 'pc1', toIp: null } }))
      .toThrow(/verify: toIp must be a non-empty string/);
    expect(() => validateLab({ ...base, verify: { from: 'pc1', toIp: 'pc2' } }))
      .toThrow(/verify: toIp must be an IPv4 address/);
    expect(() => validateLab({ ...base, verify: { from: 'pc1', toIp: '10.0.0.2' } })).not.toThrow();
  });

  it('accepts a sign-off ping aimed at a device, and holds it to the same rule', () => {
    const base = lab({ type: 'canPing', from: 'pc1', toDevice: 'pc2' });
    expect(() => validateLab({ ...base, verify: { from: 'pc1', toDevice: 'pc2' } })).not.toThrow();

    expect(() => validateLab({ ...base, verify: { from: 'pc1' } }))
      .toThrow(/verify: needs exactly one of toIp, toDevice — found neither/);
    expect(() => validateLab({ ...base, verify: { from: 'pc1', toIp: '10.0.0.2', toDevice: 'pc2' } }))
      .toThrow(/verify: needs exactly one of toIp, toDevice — found toIp and toDevice/);
    expect(() => validateLab({ ...base, verify: { from: 'pc1', toDevice: null } }))
      .toThrow(/verify: toDevice must be a non-empty string/);
  });
});
