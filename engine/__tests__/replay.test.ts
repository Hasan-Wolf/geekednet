/**
 * Replay schema checks.
 *
 * A replay's whole failure mode is silence: a step with a typo'd field, or one
 * naming a device the lab no longer has, would run to completion having changed
 * nothing — and still produce a video, of the lab not being solved. So every
 * case here is about something being rejected loudly, by name, at import.
 */
import { describe, expect, it } from 'vitest';
import {
  REPLAY_STEP_TYPES,
  ReplaySchemaError,
  getReplay,
  replays,
  runPacketTarget,
  tier2StaticRouteWalkthrough,
  validateReplay,
  validateReplayAgainstLab,
  validateStep,
  type NetworkState,
  type Replay,
  type RunPacketStep,
} from '../index.js';
import { tier0FirstPing, tier2StaticRoute } from '../labs/index.js';

/** A minimal well-formed replay for tier 2; each test breaks exactly one thing. */
function base(): Record<string, unknown> {
  return {
    id: 'test.replay',
    labId: 'tier2-static-route.learn',
    steps: [{ type: 'wait', ms: 10 }],
  };
}

const step = (s: unknown) => () => validateStep(s, 'r step #0');

describe('step shapes', () => {
  it('accepts one of each step type', () => {
    const fine: unknown[] = [
      { type: 'configure', deviceId: 'pc1', interfaceId: 'e0', field: 'ip', value: '10.0.0.5' },
      { type: 'configure', deviceId: 'pc1', interfaceId: 'e0', field: 'mask', value: '255.255.255.0' },
      { type: 'configure', deviceId: 'pc1', field: 'gateway', value: '10.0.0.1' },
      { type: 'configure', deviceId: 'pc1', field: 'powered', value: 'off' },
      { type: 'addRoute', deviceId: 'r1', dst: '20.0.0.0', mask: '255.255.255.0', gateway: '172.16.0.2' },
      { type: 'runPacket', src: 'pc1', dstIp: '10.0.0.9' },
      { type: 'runPacket', src: 'pc1', dstDevice: 'pc2' },
      { type: 'wait', ms: 0 },
      { type: 'highlight', objectiveId: 'o1', settleMs: 500, note: 'why' },
    ];
    for (const s of fine) expect(step(s)).not.toThrow();
  });

  it('names the known step types when it does not recognise one', () => {
    expect(step({ type: 'clickButton', selector: '#go' })).toThrow(ReplaySchemaError);
    expect(step({ type: 'clickButton' })).toThrow(/unknown step type "clickButton"/);
    // The list is what tells an author what they *can* write.
    expect(step({ type: 'clickButton' })).toThrow(/known types: .*runPacket/);
    expect(REPLAY_STEP_TYPES).toEqual(['configure', 'addRoute', 'runPacket', 'wait', 'highlight']);
  });

  it('rejects a misspelled field rather than reading it as absent', () => {
    expect(step({ type: 'highlight', objectiveID: 'o1' })).toThrow(/unknown field "objectiveID"/);
    expect(step({ type: 'runPacket', src: 'pc1', dstIP: '10.0.0.1' })).toThrow(
      /unknown field "dstIP"/,
    );
  });

  it('rejects a missing required field', () => {
    expect(step({ type: 'highlight' })).toThrow(/missing required field "objectiveId"/);
    expect(step({ type: 'addRoute', deviceId: 'r1', dst: '20.0.0.0', mask: '255.255.255.0' })).toThrow(
      /missing required field "gateway"/,
    );
  });

  it('needs exactly one destination on runPacket', () => {
    expect(step({ type: 'runPacket', src: 'pc1' })).toThrow(
      /needs exactly one of dstIp, dstDevice — found neither/,
    );
    expect(
      step({ type: 'runPacket', src: 'pc1', dstIp: '10.0.0.1', dstDevice: 'pc2' }),
    ).toThrow(/found dstIp and dstDevice/);
  });

  it('rejects null where a value belongs, and says to omit it', () => {
    expect(step({ type: 'highlight', objectiveId: null })).toThrow(
      /"objectiveId" must be a non-empty string, got null/,
    );
    expect(step({ type: 'highlight', objectiveId: 'o1', note: null })).toThrow(
      /omit the field instead/,
    );
    expect(step({ type: 'highlight', objectiveId: '   ' })).toThrow(/"objectiveId"/);
  });

  it('wants a number for a duration, not a string', () => {
    expect(step({ type: 'wait', ms: '400' })).toThrow(/"ms" must be a duration in milliseconds/);
    expect(step({ type: 'wait', ms: -1 })).toThrow(/zero or more/);
    expect(step({ type: 'wait', ms: Number.POSITIVE_INFINITY })).toThrow(/finite number/);
    expect(step({ type: 'highlight', objectiveId: 'o1', settleMs: 'slow' })).toThrow(
      /"settleMs" must be a duration/,
    );
  });

  it('gives wait no settleMs of its own', () => {
    // Two pauses on one step leaves an author guessing which one applies.
    expect(step({ type: 'wait', ms: 100, settleMs: 100 })).toThrow(/unknown field "settleMs"/);
  });

  it('ties a configure step to the right field', () => {
    expect(step({ type: 'configure', deviceId: 'pc1', field: 'ip', value: '10.0.0.5' })).toThrow(
      /belongs to an interface — add "interfaceId"/,
    );
    expect(
      step({ type: 'configure', deviceId: 'pc1', interfaceId: 'e0', field: 'gateway', value: '10.0.0.1' }),
    ).toThrow(/belongs to the device, not an interface — drop "interfaceId"/);
    expect(step({ type: 'configure', deviceId: 'pc1', field: 'dns', value: 'x' })).toThrow(
      /"field" must be one of ip, mask, gateway, powered/,
    );
  });

  it('checks a configure value against the field it sets', () => {
    expect(step({ type: 'configure', deviceId: 'pc1', field: 'powered', value: 'yes' })).toThrow(
      /must be one of on, off/,
    );
    // A mask the engine can't parse is a mask no student can type.
    expect(
      step({ type: 'configure', deviceId: 'pc1', interfaceId: 'e0', field: 'mask', value: '255.0.255.0' }),
    ).toThrow(/contiguous IPv4 subnet mask/);
    expect(
      step({ type: 'configure', deviceId: 'pc1', interfaceId: 'e0', field: 'ip', value: '10.0.0' }),
    ).toThrow(/must be an IPv4 address/);
    expect(step({ type: 'configure', deviceId: 'pc1', field: 'gateway', value: 'router' })).toThrow(
      /must be an IPv4 address/,
    );
  });

  it('checks addresses and masks on a route', () => {
    const route = { type: 'addRoute', deviceId: 'r1', dst: '20.0.0.0', mask: '255.255.255.0', gateway: '172.16.0.2' };
    expect(step({ ...route, dst: '20.0.0' })).toThrow(/"dst" must be an IPv4 address/);
    expect(step({ ...route, mask: '255.255.0.1' })).toThrow(/contiguous IPv4 subnet mask/);
    expect(step({ ...route, gateway: 'nope' })).toThrow(/"gateway" must be an IPv4 address/);
  });

  it('locates the step for the author', () => {
    expect(() => validateStep({ type: 'nope' }, 'replay demo.walkthrough step #3')).toThrow(
      /^replay demo\.walkthrough step #3:/,
    );
  });

  it('rejects a step that is not an object', () => {
    expect(step(null)).toThrow(/step must be an object, got null/);
    expect(step('runPacket')).toThrow(/step must be an object/);
  });
});

describe('replay shapes', () => {
  it('accepts a well-formed replay', () => {
    expect(() => validateReplay(base())).not.toThrow();
  });

  it('requires an id, a labId and some steps', () => {
    expect(() => validateReplay({ ...base(), id: undefined })).toThrow(/id must be a non-empty string/);
    expect(() => validateReplay({ ...base(), labId: null })).toThrow(/labId must be a non-empty string/);
    expect(() => validateReplay({ ...base(), steps: {} })).toThrow(/steps must be an array/);
    // Otherwise the "walkthrough" is a screenshot of the broken starting state.
    expect(() => validateReplay({ ...base(), steps: [] })).toThrow(/steps is empty/);
  });

  it('names the replay and the step index in an error', () => {
    const bad = { ...base(), steps: [{ type: 'wait', ms: 1 }, { type: 'nope' }] };
    expect(() => validateReplay(bad)).toThrow(/^replay test\.replay step #1:/);
  });

  it('rejects an empty optional string rather than ignoring it', () => {
    expect(() => validateReplay({ ...base(), title: '' })).toThrow(/title must be a non-empty string/);
  });
});

describe('against the lab it drives', () => {
  const replay = (steps: unknown[]): Replay =>
    validateReplay({ ...base(), steps });

  const check = (steps: unknown[], lab = tier2StaticRoute) => () =>
    validateReplayAgainstLab(replay(steps), lab);

  it('accepts a replay that only names things the lab has', () => {
    expect(
      check([
        { type: 'highlight', objectiveId: 'o1' },
        { type: 'addRoute', deviceId: 'r1', dst: '20.0.0.0', mask: '255.255.255.0', gateway: '172.16.0.2' },
        { type: 'configure', deviceId: 'pcR', interfaceId: 'e0', field: 'ip', value: '10.0.0.10' },
        { type: 'configure', deviceId: 'pcR', field: 'gateway', value: '10.0.0.1' },
        { type: 'runPacket', src: 'pcR', dstDevice: 'pcB' },
      ]),
    ).not.toThrow();
  });

  it('rejects a device the lab does not have, and lists the ones it does', () => {
    expect(check([{ type: 'addRoute', deviceId: 'r9', dst: '1.0.0.0', mask: '255.0.0.0', gateway: '10.0.0.1' }]))
      .toThrow(/has no device "r9"/);
    expect(check([{ type: 'runPacket', src: 'nope', dstIp: '20.0.0.10' }])).toThrow(
      /known devices: pcR, r1, r2, pcB/,
    );
    expect(check([{ type: 'runPacket', src: 'pcR', dstDevice: 'ghost' }])).toThrow(
      /\(dstDevice\): lab .* has no device "ghost"/,
    );
  });

  it('rejects an interface the device does not have', () => {
    expect(check([{ type: 'configure', deviceId: 'pcR', interfaceId: 'e9', field: 'ip', value: '10.0.0.5' }]))
      .toThrow(/has no interface "e9" — known: e0/);
  });

  it('rejects a field the kind of device does not have', () => {
    // Each of these would have been accepted and then done nothing visible.
    expect(check([{ type: 'configure', deviceId: 'r1', field: 'gateway', value: '10.0.0.1' }])).toThrow(
      /only end hosts take a default gateway/,
    );
    expect(check([{ type: 'addRoute', deviceId: 'pcR', dst: '20.0.0.0', mask: '255.255.255.0', gateway: '10.0.0.1' }]))
      .toThrow(/only routers take static routes/);
    // The switch lives in tier 0, so this one is checked against that lab.
    const onASwitch = validateReplay({
      id: 'test.tier0',
      labId: tier0FirstPing.id,
      steps: [{ type: 'configure', deviceId: 'sw', interfaceId: 'p1', field: 'ip', value: '192.168.1.1' }],
    });
    expect(() => validateReplayAgainstLab(onASwitch, tier0FirstPing)).toThrow(
      /is a switch — a layer-2 port has no IP or mask to set/,
    );
  });

  it('rejects an objective id the lab no longer has', () => {
    expect(check([{ type: 'highlight', objectiveId: 'o9' }])).toThrow(
      /has no objective "o9" — known: o1, o2, o3/,
    );
  });

  it('refuses to be checked against the wrong lab', () => {
    expect(() => validateReplayAgainstLab(replay([{ type: 'wait', ms: 1 }]), tier0FirstPing)).toThrow(
      /drives lab "tier2-static-route.learn", checked against "tier0-first-ping.learn"/,
    );
  });
});

describe('the registry', () => {
  it('ships a replay that validates against its own lab', () => {
    expect(replays.length).toBeGreaterThan(0);
    for (const r of replays) {
      expect(() => validateReplay(r)).not.toThrow();
    }
  });

  it('finds the example walkthrough by id', () => {
    expect(getReplay('tier2-static-route.walkthrough')).toBe(tier2StaticRouteWalkthrough);
    expect(getReplay('nope')).toBeUndefined();
  });

  it('drives the lab it says it drives, and ends with its sign-off ping', () => {
    const { labId, steps } = tier2StaticRouteWalkthrough;
    expect(labId).toBe(tier2StaticRoute.id);
    const last = steps[steps.length - 1];
    expect(last.type).toBe('runPacket');
    // The lab's own verifying ping, or the walkthrough stops short of the win bar.
    expect(last).toMatchObject({ src: tier2StaticRoute.verify!.from, dstIp: tier2StaticRoute.verify!.toIp });
  });
});

describe('runPacketTarget', () => {
  const state = (): NetworkState => structuredClone(tier0FirstPing.initialState);

  it('uses a pinned address as given', () => {
    const s: RunPacketStep = { type: 'runPacket', src: 'pc1', dstIp: '192.168.1.11' };
    expect(runPacketTarget(state(), s)).toBe('192.168.1.11');
  });

  it('resolves a named device against live state, not the lab file', () => {
    const net = state();
    const s: RunPacketStep = { type: 'runPacket', src: 'pc1', dstDevice: 'pc2' };
    // Tier 0 ships both PCs unaddressed — the student picks. Nothing to ping yet.
    expect(runPacketTarget(net, s)).toBeUndefined();

    net.devices.find((d) => d.id === 'pc2')!.interfaces[0].ip = '192.168.1.77';
    expect(runPacketTarget(net, s)).toBe('192.168.1.77');
  });
});
