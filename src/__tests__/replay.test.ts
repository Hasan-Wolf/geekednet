/**
 * Replay mode, end to end through the store.
 *
 * The claim this file exists to pin down is that a replay is not a second way to
 * play a lab: it dispatches the same actions, hits the same engine, and finishes
 * the lab by the same route a student does — green objectives, the "prove it"
 * prompt, the sign-off ping, then the win bar. If replay mode ever grew its own
 * shortcut to a finished lab, the recorded video would stop being evidence of
 * anything, and these assertions would be the first to notice.
 *
 * Nothing here touches the DOM. The one thing the canvas owns is reporting that
 * a packet finished its flight, which `pretendCanvas` stands in for — see
 * `packetArrived` in the store and the `Packet` component that calls it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { tier2StaticRouteWalkthrough, type Replay } from '../../engine/index.js';
import {
  AUTO_REPLAY,
  ReplayRunError,
  readReplayRequest,
  resolveReplayRequest,
  runReplay,
  startReplayFromUrl,
  type ReplayStatus,
} from '../replay.js';
import { useStore } from '../store.js';

const s = () => useStore.getState();

const TIER2 = 'tier2-static-route.learn';
const WALKTHROUGH = 'tier2-static-route.walkthrough';

/** No pacing: every pause resolves on the microtask queue. */
const instant = { sleep: () => Promise.resolve() };

/**
 * Stand in for the canvas's animation loop.
 *
 * `Packet` reports `onArrive` when its last head reaches the far end, and the
 * store holds the win bar back until then. Without something playing that part,
 * a replay's ping would be left waiting for a flight that never happens.
 */
function pretendCanvas(): () => void {
  const seen = new Set<number>();
  return useStore.subscribe((state) => {
    const packet = state.packet;
    if (packet && !seen.has(packet.id)) {
      seen.add(packet.id);
      s().packetArrived(packet.id);
    }
  });
}

let stopCanvas: (() => void) | null = null;

afterEach(() => {
  stopCanvas?.();
  stopCanvas = null;
  // Replay mode is one-way in the app (a reload is how you leave it), so the
  // tests put the store back by hand.
  useStore.setState({ replayMode: false });
  s().resetProgress();
});

describe('reading the URL', () => {
  it('ignores a plain visit', () => {
    expect(readReplayRequest('')).toBeNull();
    expect(readReplayRequest('?foo=bar')).toBeNull();
  });

  it('reads both parameters', () => {
    expect(readReplayRequest(`?lab=${TIER2}&replay=${WALKTHROUGH}`)).toEqual({
      labId: TIER2,
      replayId: WALKTHROUGH,
    });
  });

  it('takes the lab from the replay when only a replay is named', () => {
    const { lab, replay } = resolveReplayRequest(readReplayRequest(`?replay=${WALKTHROUGH}`)!);
    expect(lab.id).toBe(TIER2);
    expect(replay?.id).toBe(WALKTHROUGH);
  });

  it('treats ?lab= on its own as a deep link with nothing to play', () => {
    const { lab, replay } = resolveReplayRequest(readReplayRequest(`?lab=${TIER2}`)!);
    expect(lab.id).toBe(TIER2);
    expect(replay).toBeNull();
  });

  it('refuses an unknown lab instead of quietly loading the first one', () => {
    // `loadLab` falls back to the sandbox for an id it doesn't know, which for a
    // recording would mean filming the wrong thing and never saying so.
    expect(() => resolveReplayRequest({ labId: 'tier9-nope', replayId: null })).toThrow(
      ReplayRunError,
    );
    expect(() => resolveReplayRequest({ labId: 'tier9-nope', replayId: null })).toThrow(
      /unknown lab "tier9-nope" — known labs: sandbox, tier0/,
    );
  });

  it('refuses an unknown replay', () => {
    expect(() => resolveReplayRequest({ labId: TIER2, replayId: 'nope' })).toThrow(
      /unknown replay "nope"/,
    );
  });

  it('refuses a lab and a replay that disagree', () => {
    expect(() =>
      resolveReplayRequest({ labId: 'tier0-first-ping.learn', replayId: WALKTHROUGH }),
    ).toThrow(/drives lab "tier2-static-route.learn", but \?lab="tier0-first-ping.learn"/);
  });
});

describe('?replay=auto', () => {
  it('derives a walkthrough for a lab that has no replay JSON', () => {
    // tier0 and tier1 ship no hand-written replay; this is the whole point.
    const { lab, replay } = resolveReplayRequest(
      readReplayRequest(`?lab=tier0-first-ping.learn&replay=${AUTO_REPLAY}`)!,
    );
    expect(lab.id).toBe('tier0-first-ping.learn');
    expect(replay?.labId).toBe('tier0-first-ping.learn');
    expect(replay?.steps.length).toBeGreaterThan(0);
  });

  it('requires a lab, since it names none itself', () => {
    expect(() => resolveReplayRequest({ labId: null, replayId: AUTO_REPLAY })).toThrow(
      /derives a walkthrough from a lab, so \?lab= is required/,
    );
  });

  it('is not looked up as a stored replay id', () => {
    // Were `auto` resolved through the registry it would be "unknown replay".
    expect(() => resolveReplayRequest({ labId: TIER2, replayId: AUTO_REPLAY })).not.toThrow();
  });

  it('plays a derived walkthrough through to the win bar', async () => {
    const TIER1 = 'tier1-fix-mask.learn';
    s().resetProgress();
    s().enterReplayMode();
    const { lab, replay } = resolveReplayRequest({ labId: TIER1, replayId: AUTO_REPLAY });
    s().loadLab(lab.id);
    stopCanvas = pretendCanvas();

    expect(s().objectiveResults.every((o) => o.complete)).toBe(false);

    await runReplay(replay!, instant);

    // The same bar a student clears, reached by a replay nobody wrote: every
    // objective green, the sign-off ping flown, the lab banked.
    expect(s().objectiveResults.every((o) => o.complete)).toBe(true);
    expect(s().completedLabs).toContain(TIER1);
    expect(s().lastResult?.success).toBe(true);
  });
});

describe('the example walkthrough', () => {
  it('finishes the lab the way a student would', async () => {
    s().resetProgress();
    s().enterReplayMode();
    s().loadLab(TIER2);
    stopCanvas = pretendCanvas();

    expect(s().objectiveResults.every((o) => o.complete)).toBe(false);
    expect(s().xp).toBe(0);

    await runReplay(tier2StaticRouteWalkthrough, instant);

    // Both routes are on the routers, typed into the same table the panel edits.
    const routes = (id: string) => s().network.devices.find((d) => d.id === id)!.routes;
    expect(routes('r1')).toEqual([
      { dst: '20.0.0.0', mask: '255.255.255.0', gateway: '172.16.0.2' },
    ]);
    expect(routes('r2')).toEqual([
      { dst: '10.0.0.0', mask: '255.255.255.0', gateway: '172.16.0.1' },
    ]);

    // Every objective green, the sign-off ping run, the lab banked.
    expect(s().objectiveResults.every((o) => o.complete)).toBe(true);
    expect(s().completedLabs).toContain(TIER2);
    expect(s().justCompleted).toBe(TIER2);
    expect(s().xp).toBe(250);
    expect(s().earnedBadges).toContain('route-finder');
  });

  it('sends the packet the whole way across the canvas', async () => {
    s().resetProgress();
    s().enterReplayMode();
    s().loadLab(TIER2);
    stopCanvas = pretendCanvas();

    await runReplay(tier2StaticRouteWalkthrough, instant);

    // The path came from `simulatePacket` by way of the terminal's `ping` — the
    // replay has no way to draw a path of its own.
    expect(s().lastResult?.success).toBe(true);
    expect(s().ambientPath).toEqual(['pcR', 'r1', 'r2', 'pcB']);
    expect(s().terminalLog.some((l) => l.text.includes('ping 20.0.0.10'))).toBe(true);
    expect(s().terminalLog.some((l) => l.text.includes('3 received'))).toBe(true);
  });

  it('runs the ping from the device the step names', async () => {
    s().resetProgress();
    s().enterReplayMode();
    s().loadLab(TIER2);
    stopCanvas = pretendCanvas();

    await runReplay(tier2StaticRouteWalkthrough, instant);

    expect(s().terminalDeviceId).toBe('pcR');
    expect(s().commandHistory).toContain('ping 20.0.0.10');
  });

  it('visits every step and clears the spotlight at the end', async () => {
    s().resetProgress();
    s().enterReplayMode();
    s().loadLab(TIER2);
    stopCanvas = pretendCanvas();

    const seen: number[] = [];
    await runReplay(tier2StaticRouteWalkthrough, {
      ...instant,
      onStep: (index) => seen.push(index),
    });

    expect(seen).toEqual(tier2StaticRouteWalkthrough.steps.map((_, i) => i));
    expect(s().highlightedObjectiveId).toBeNull();
  });
});

describe('replay mode vs. saved progress', () => {
  it('banks the lab in memory but writes nothing down', async () => {
    s().resetProgress();
    const writes: string[] = [];
    const original = globalThis.localStorage;
    // The store guards every storage access, so in this environment there is
    // simply nothing there; a stub is the only way to catch a write.
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: (key: string) => writes.push(key),
        removeItem: () => {},
      },
    });

    try {
      s().enterReplayMode();
      s().loadLab(TIER2);
      stopCanvas = pretendCanvas();
      await runReplay(tier2StaticRouteWalkthrough, instant);

      expect(s().completedLabs).toContain(TIER2); // the win bar did rise…
      expect(writes).toEqual([]); // …and none of it was saved
    } finally {
      if (original) {
        Object.defineProperty(globalThis, 'localStorage', {
          configurable: true,
          value: original,
        });
      } else {
        delete (globalThis as { localStorage?: unknown }).localStorage;
      }
    }
  });

  it('unlocks every lab so the tour does not padlock its own subject', () => {
    s().resetProgress();
    expect(s().unlocked).not.toContain(TIER2);
    s().enterReplayMode();
    for (const lab of s().labs) expect(s().unlocked).toContain(lab.id);
  });
});

describe('a replay that cannot be carried out', () => {
  const broken = (steps: Replay['steps']): Replay => ({
    id: 'test.broken',
    labId: TIER2,
    steps,
  });

  it('throws on a step type with no runner', async () => {
    const step = { type: 'clickButton', selector: '#go' } as unknown as Replay['steps'][number];
    await expect(runReplay(broken([step]), instant)).rejects.toThrow(/unknown step type/);
  });

  it('throws when a named destination has no address yet', async () => {
    s().resetProgress();
    s().loadLab('tier0-first-ping.learn');
    // Tier 0 ships both PCs unaddressed, so there is nothing to ping.
    const replay: Replay = {
      id: 'test.tier0',
      labId: 'tier0-first-ping.learn',
      steps: [{ type: 'runPacket', src: 'pc1', dstDevice: 'pc2' }],
    };
    await expect(runReplay(replay, instant)).rejects.toThrow(
      /nothing to ping — device "pc2" has no address yet/,
    );
  });

  it('reports a packet that never lands instead of hanging or failing', async () => {
    s().resetProgress();
    s().enterReplayMode();
    s().loadLab(TIER2);
    // No pretendCanvas: nothing will ever report the flight finishing, which is
    // what a throttled or hidden tab looks like.
    const warnings: string[] = [];
    await runReplay(tier2StaticRouteWalkthrough, {
      ...instant,
      onWarning: (m) => warnings.push(m),
    });

    expect(warnings.join('\n')).toMatch(/never reported landing/);
    // The config still happened and the lab still knows it is waiting on a ping.
    expect(s().objectiveResults.every((o) => o.complete)).toBe(true);
  });
});

describe('startReplayFromUrl', () => {
  it('does nothing without the parameters', async () => {
    s().resetProgress();
    const before = s().activeLabId;
    await startReplayFromUrl('?nothing=here');
    expect(s().activeLabId).toBe(before);
  });

  it('loads the lab and plays the replay', async () => {
    s().resetProgress();
    stopCanvas = pretendCanvas();
    await startReplayFromUrl(`?lab=${TIER2}&replay=${WALKTHROUGH}`, instant);
    expect(s().activeLabId).toBe(TIER2);
    expect(s().completedLabs).toContain(TIER2);
  });

  it('puts a bad request on the canvas rather than only in the console', async () => {
    s().resetProgress();
    await startReplayFromUrl('?replay=does-not-exist');
    expect(s().lastResult?.success).toBe(false);
    expect(s().lastResult?.reason).toMatch(/replay failed: unknown replay "does-not-exist"/);
  });

  /**
   * Run a replay and hand back what `publish` put on `window`.
   *
   * `publish` is a no-op without a `window`, and this file is deliberately
   * DOM-free — so rather than pull in jsdom for two assertions, `window` stands
   * up as an alias of `globalThis` for the duration and is taken down after.
   */
  async function publishedStatusFor(search: string): Promise<ReplayStatus | undefined> {
    const had = 'window' in globalThis;
    if (!had) (globalThis as { window?: unknown }).window = globalThis;
    try {
      await startReplayFromUrl(search, instant);
      return (globalThis as { __geekednetReplay?: ReplayStatus }).__geekednetReplay;
    } finally {
      if (!had) delete (globalThis as { window?: unknown }).window;
      delete (globalThis as { __geekednetReplay?: ReplayStatus }).__geekednetReplay;
    }
  }

  it('publishes the subtitle track on the finished status', async () => {
    // This is the whole contract the recorder reads to write the .srt beside
    // the clip; it must be on `done`, and it must be text, not cues.
    s().resetProgress();
    stopCanvas = pretendCanvas();
    const status = await publishedStatusFor(`?lab=${TIER2}&replay=${WALKTHROUGH}`);

    expect(status?.status).toBe('done');
    expect(status?.captions?.srt).toMatch(/^1\n00:00:00,000 --> /);
    expect(status?.captions?.durationMs).toBeGreaterThan(0);
    // One cue per step that carries a note.
    const noted = tier2StaticRouteWalkthrough.steps.filter((step) => step.note?.trim()).length;
    expect(status?.captions?.srt.trimEnd().split('\n\n')).toHaveLength(noted);
    expect(status?.warnings).toEqual([]);
  });

  it('carries subtitles for a derived walkthrough too', async () => {
    s().resetProgress();
    stopCanvas = pretendCanvas();
    const status = await publishedStatusFor(`?lab=tier1-fix-mask.learn&replay=${AUTO_REPLAY}`);

    expect(status?.status).toBe('done');
    expect(status?.captions?.srt).toContain('That disagreement is what stops the two seeing');
  });
});
