/**
 * Generated-walkthrough checks.
 *
 * Two things have to hold for a derived replay to be worth having, and they pull
 * in opposite directions:
 *
 *  - It must clear the same bar as a hand-written one — `validateReplay` and
 *    `validateReplayAgainstLab`, the checks the registry applies at import.
 *  - It must actually *solve the lab*. A replay can be perfectly well-formed and
 *    still produce a video of a lab not being finished, which is the failure the
 *    whole replay schema is built to make impossible. So the steps are applied
 *    to a working network and the lab's own `isLabComplete` is asked, and the
 *    pings are run through the real simulator.
 *
 * The last case is the one that would have caught hand-authoring drift: the
 * generated tier-2 walkthrough is compared against the one written by hand,
 * action for action.
 */
import { describe, expect, it } from 'vitest';
import {
  CaptionTimingError,
  ReplayGenerationError,
  generateReplay,
  isLabComplete,
  ping,
  replayCaptions,
  runPacketTarget,
  toSrt,
  toVtt,
  validateReplay,
  validateReplayAgainstLab,
  type Lab,
  type NetworkState,
  type Replay,
  type ReplayStep,
} from '../index.js';
import { labs, tier0FirstPing, tier1FixMask, tier2StaticRoute } from '../labs/index.js';
import { tier2StaticRouteWalkthrough } from '../replays/index.js';

/**
 * Apply a replay's steps to a fresh copy of the lab's network.
 *
 * The real runner dispatches each step through the store actions the UI binds to
 * its own inputs (see src/replay.ts); this is the same arithmetic without React,
 * so a test can ask the engine whether the lab ended up solved. `runPacket` goes
 * through the actual simulator, not a stub — a step that claims a ping succeeds
 * has to prove it.
 */
function play(lab: Lab, replay: Replay) {
  const net: NetworkState = structuredClone(lab.initialState);
  const pings: Array<{ from: string; to: string | undefined; success: boolean }> = [];

  for (const step of replay.steps) {
    switch (step.type) {
      case 'configure': {
        const device = net.devices.find((d) => d.id === step.deviceId);
        if (!device) throw new Error(`step names unknown device ${step.deviceId}`);
        if (step.field === 'powered') {
          device.powered = step.value === 'on';
          break;
        }
        if (step.field === 'gateway') {
          device.gateway = step.value;
          break;
        }
        const iface = device.interfaces.find((i) => i.id === step.interfaceId);
        if (!iface) throw new Error(`step names unknown interface ${step.interfaceId}`);
        iface[step.field] = step.value;
        break;
      }
      case 'addRoute': {
        const device = net.devices.find((d) => d.id === step.deviceId);
        if (!device) throw new Error(`step names unknown device ${step.deviceId}`);
        device.routes ??= [];
        device.routes.push({ dst: step.dst, mask: step.mask, gateway: step.gateway });
        break;
      }
      case 'runPacket': {
        const to = runPacketTarget(net, step);
        pings.push({ from: step.src, to, success: to ? ping(net, step.src, to).success : false });
        break;
      }
      default:
        break; // `highlight` and `wait` change no state
    }
  }

  return { net, pings };
}

/** A step's action, with the prose and pacing stripped off. */
function action(step: ReplayStep): string {
  const { note: _note, ...rest } = step as ReplayStep & { note?: string };
  const { settleMs: _settleMs, ...bare } = rest as Record<string, unknown> & { settleMs?: number };
  return JSON.stringify(bare);
}

describe('generateReplay', () => {
  it.each(labs.map((lab) => [lab.id, lab] as const))(
    'derives a schema-valid replay for %s',
    (_id, lab) => {
      const replay = generateReplay(lab);
      // The same two gates the replay registry applies to authored JSON.
      expect(() => validateReplay(replay)).not.toThrow();
      expect(() => validateReplayAgainstLab(validateReplay(replay), lab)).not.toThrow();
      expect(replay.labId).toBe(lab.id);
      expect(replay.steps.length).toBeGreaterThan(0);
    },
  );

  it.each(labs.map((lab) => [lab.id, lab] as const))('actually solves %s', (_id, lab) => {
    const { net, pings } = play(lab, generateReplay(lab));
    expect(isLabComplete(net, lab)).toBe(true);
    // Every ping the walkthrough runs has to land, or the clip ends on a failure
    // banner with every objective green.
    expect(pings.length).toBeGreaterThan(0);
    for (const attempt of pings) expect(attempt.success).toBe(true);
  });

  it('leaves the lab it was given untouched', () => {
    // A lab's initialState is shared by every session that loads it.
    const before = JSON.stringify(tier0FirstPing);
    generateReplay(tier0FirstPing);
    expect(JSON.stringify(tier0FirstPing)).toBe(before);
  });

  it('reproduces the hand-written tier-2 walkthrough, action for action', () => {
    const generated = generateReplay(tier2StaticRoute);
    expect(generated.steps.map(action)).toEqual(tier2StaticRouteWalkthrough.steps.map(action));
  });

  it('sets only the field that is wrong', () => {
    // The Silent PC has a correct address and a wrong mask. A `configure` step
    // for the address would be a step a viewer watches nothing happen during.
    const replay = generateReplay(tier1FixMask);
    const configures = replay.steps.filter((s) => s.type === 'configure');
    expect(configures).toHaveLength(1);
    expect(configures[0]).toMatchObject({ deviceId: 'pc2', field: 'mask', value: '255.255.255.0' });
  });

  it('hands out a different address to each host that has to choose one', () => {
    const replay = generateReplay(tier0FirstPing);
    const addresses = replay.steps
      .filter((s) => s.type === 'configure' && s.field === 'ip')
      .map((s) => (s as { value: string }).value);
    expect(addresses).toHaveLength(2);
    expect(new Set(addresses).size).toBe(2);
  });

  it('opens on the broken state before touching anything', () => {
    const [first] = generateReplay(tier1FixMask).steps;
    expect(first.type).toBe('wait');
  });

  it('ends on a packet for every lab that signs off with one', () => {
    for (const lab of labs.filter((l) => l.verify)) {
      const steps = generateReplay(lab).steps;
      expect(steps[steps.length - 1].type).toBe('runPacket');
    }
  });

  it('does not add a second ping when an objective already ran the verify one', () => {
    // tier1's last objective and its `verify` block are the same ping.
    const pings = generateReplay(tier1FixMask).steps.filter((s) => s.type === 'runPacket');
    expect(pings).toHaveLength(1);
  });

  it('honours a pace override', () => {
    const replay = generateReplay(tier1FixMask, { pace: { configure: 50 } });
    const configure = replay.steps.find((s) => s.type === 'configure');
    expect(configure).toMatchObject({ settleMs: 50 });
  });

  it('carries an explicit settleMs on every paced step', () => {
    // So a generated replay reads to the runner exactly as an authored one does,
    // and its captions can be timed without the runner's defaults.
    for (const lab of labs) {
      for (const step of generateReplay(lab).steps) {
        if (step.type === 'wait') expect(step.ms).toBeGreaterThan(0);
        else expect(step.settleMs).toBeGreaterThan(0);
      }
    }
  });
});

describe('generateReplay — loud failures', () => {
  /** A copy of a lab with its objectives replaced. */
  function withObjectives(lab: Lab, objectives: Lab['objectives']): Lab {
    return { ...structuredClone(lab), objectives, verify: undefined };
  }

  it('refuses an objective no step can satisfy, naming it', () => {
    const lab = withObjectives(tier1FixMask, [
      { id: 'oX', description: 'Run nmap', check: { type: 'commandRun', matches: '^nmap' } },
    ]);
    expect(() => generateReplay(lab)).toThrow(ReplayGenerationError);
    expect(() => generateReplay(lab)).toThrow(/objective oX.*commandRun/s);
  });

  it('refuses an objective naming a device the lab does not have', () => {
    const lab = withObjectives(tier2StaticRoute, [
      {
        id: 'oGhost',
        description: 'Route via a router that is not here',
        check: { type: 'hasRoute', device: 'nope', dst: '20.0.0.0', mask: '255.255.255.0', gateway: '172.16.0.2' },
      },
    ]);
    expect(() => generateReplay(lab)).toThrow(/no device "nope"/);
  });

  it('refuses an objective naming an interface the device does not have', () => {
    const lab = withObjectives(tier1FixMask, [
      {
        id: 'oBadIface',
        description: 'Address an interface that is not there',
        check: { type: 'ifaceHasIp', device: 'pc1', iface: 'e9', ip: '192.168.1.20', mask: '255.255.255.0' },
      },
    ]);
    expect(() => generateReplay(lab)).toThrow(/no interface "e9"/);
  });

  it('refuses a subnet with no room left', () => {
    // A /32 holds one address, and the objective asks for a host in it.
    const lab = withObjectives(tier1FixMask, [
      {
        id: 'oFull',
        description: 'Impossible',
        check: { type: 'ifaceInNetwork', device: 'pc1', iface: 'e0', network: '10.0.0.1', mask: '255.255.255.255' },
      },
    ]);
    // 10.0.0.1/32 is a single host address, already taken by nothing — so the
    // pick succeeds. Take it with pc2 first to leave the subnet genuinely full.
    const full = structuredClone(lab);
    full.initialState.devices.find((d) => d.id === 'pc2')!.interfaces[0].ip = '10.0.0.1';
    expect(() => generateReplay(full)).toThrow(/no free host address/);
  });
});

describe('replayCaptions', () => {
  it('times every note against the span its step is on screen', () => {
    const replay = generateReplay(tier1FixMask);
    const track = replayCaptions(replay);

    // Each note becomes one cue, and the clock never goes backwards.
    const noted = replay.steps.filter((s) => s.note?.trim()).length;
    expect(track.captions).toHaveLength(noted);
    for (let i = 1; i < track.captions.length; i += 1) {
      expect(track.captions[i].startMs).toBeGreaterThanOrEqual(track.captions[i - 1].endMs);
    }

    // The track is exactly as long as the replay it came from.
    const total = replay.steps.reduce(
      (sum, step) => sum + (step.type === 'wait' ? step.ms : (step.settleMs ?? 0)),
      0,
    );
    expect(track.durationMs).toBe(total);
    expect(track.captions[track.captions.length - 1].endMs).toBeLessThanOrEqual(total);
  });

  it('counts a step with no note as a silent beat rather than dropping it', () => {
    const replay: Replay = {
      id: 'test.silent',
      labId: tier1FixMask.id,
      steps: [
        { type: 'wait', ms: 1000 },
        { type: 'wait', ms: 500, note: 'after the silence' },
      ],
    };
    const track = replayCaptions(replay);
    expect(track.captions).toHaveLength(1);
    expect(track.captions[0].startMs).toBe(1000);
    expect(track.durationMs).toBe(1500);
  });

  it('refuses to guess a duration the replay does not carry', () => {
    const replay: Replay = {
      id: 'test.untimed',
      labId: tier1FixMask.id,
      steps: [{ type: 'highlight', objectiveId: 'o1', note: 'untimed' }],
    };
    expect(() => replayCaptions(replay)).toThrow(CaptionTimingError);
    // Unless the caller, who does hold the runner's defaults, passes them in.
    expect(replayCaptions(replay, { captionFallback: { highlight: 900 } }).durationMs).toBe(900);
  });

  it('writes valid SRT and WebVTT', () => {
    const track = replayCaptions(generateReplay(tier1FixMask));
    const srt = toSrt(track);
    expect(srt.startsWith('1\n00:00:00,000 --> ')).toBe(true);
    expect(srt).toContain(' --> ');
    // One blank-line-separated block per cue.
    expect(srt.trimEnd().split('\n\n')).toHaveLength(track.captions.length);

    const vtt = toVtt(track);
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true);
    expect(vtt).toContain('00:00:00.000 --> ');
  });

  it('stamps hours, minutes and milliseconds correctly', () => {
    const replay: Replay = {
      id: 'test.long',
      labId: tier1FixMask.id,
      steps: [
        { type: 'wait', ms: 3_661_001 },
        { type: 'wait', ms: 1, note: 'at one hour, one minute, one second' },
      ],
    };
    expect(toSrt(replayCaptions(replay))).toContain('01:01:01,001 --> 01:01:01,002');
  });
});
