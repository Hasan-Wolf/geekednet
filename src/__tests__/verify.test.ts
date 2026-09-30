/**
 * How a lab finishes, end to end through the store: green objectives → the
 * "prove it" prompt → the student's ping → the packet landing → the cut-in.
 *
 * This is the wiring the engine can't see (the engine only answers "do the
 * objectives pass?"), so the sequencing is pinned down here. Nothing in this file
 * touches the DOM — the store is plain state plus the pure engine.
 */
import { describe, it, expect } from 'vitest';
import type { Lab } from '../../engine/index.js';
import { ALL_LABS, useStore } from '../store.js';

const TIER0 = 'tier0-first-ping.learn';
const TIER2 = 'tier2-static-route.learn';

const s = () => useStore.getState();

/** Fresh player, nothing banked, sitting on `labId`. */
function start(labId: string, labs: Lab[] = ALL_LABS) {
  s().resetProgress();
  useStore.setState({ labs });
  s().loadLab(labId);
}

/** Mission 1's whole solution: both PCs on 192.168.1.0/24. */
function solveTier0() {
  const { setIfaceField } = s();
  setIfaceField('pc1', 'e0', 'ip', '192.168.1.10');
  setIfaceField('pc1', 'e0', 'mask', '255.255.255.0');
  setIfaceField('pc2', 'e0', 'ip', '192.168.1.11');
  setIfaceField('pc2', 'e0', 'mask', '255.255.255.0');
}

/** Mission 3's solution: the two mirrored static routes. */
function solveTier2() {
  const { addRoute, updateRoute } = s();
  addRoute('r1');
  updateRoute('r1', 0, 'dst', '20.0.0.0');
  updateRoute('r1', 0, 'gateway', '172.16.0.2');
  addRoute('r2');
  updateRoute('r2', 0, 'dst', '10.0.0.0');
  updateRoute('r2', 0, 'gateway', '172.16.0.1');
}

const allGreen = () => s().objectiveResults.every((o) => o.complete);

describe('ready to verify', () => {
  it('green objectives raise the prompt instead of finishing the lab', () => {
    start(TIER0);
    expect(s().verifyStatus).toBe('none');

    solveTier0();

    expect(allGreen()).toBe(true);
    expect(s().verifyStatus).toBe('ready');
    // No cut-in, no rewards — the student still has to prove it.
    expect(s().justCompleted).toBeNull();
    expect(s().completedLabs).toEqual([]);
    expect(s().xp).toBe(0);
  });

  it('breaking the config again takes the prompt back down', () => {
    start(TIER0);
    solveTier0();
    expect(s().verifyStatus).toBe('ready');

    s().setIfaceField('pc2', 'e0', 'mask', '255.255.255.128');

    expect(allGreen()).toBe(false);
    expect(s().verifyStatus).toBe('none');
  });
});

describe('the verifying ping', () => {
  it('runs as a fast packet and holds the cut-in until it lands', () => {
    start(TIER0);
    solveTier0();

    s().runTerminal('ping 192.168.1.11');

    expect(s().lastResult?.success).toBe(true);
    expect(s().packet?.verify).toBe(true); // the fast neon run, not a routine ping
    expect(s().verifyStatus).toBe('verifying');
    // Strict sequence: the packet is still in flight, so nothing has completed.
    expect(s().justCompleted).toBeNull();
    expect(s().completedLabs).toEqual([]);

    s().packetArrived(s().packet!.id);

    expect(s().justCompleted).toBe(TIER0);
    expect(s().completedLabs).toContain(TIER0);
    expect(s().xp).toBe(100);
    expect(s().verifyStatus).toBe('none');
  });

  it('follows the address the student actually chose', () => {
    // Mission 1 no longer pins .10 / .11, so the sign-off run cannot either:
    // it is "ping PC2", resolved against whatever PC2 is wearing right now.
    start(TIER0);
    const { setIfaceField } = s();
    setIfaceField('pc1', 'e0', 'ip', '192.168.1.77');
    setIfaceField('pc1', 'e0', 'mask', '255.255.255.0');
    setIfaceField('pc2', 'e0', 'ip', '192.168.1.88');
    setIfaceField('pc2', 'e0', 'mask', '255.255.255.0');
    expect(allGreen()).toBe(true);
    expect(s().verifyStatus).toBe('ready');

    // The address the old lab was signed off with is nobody's now.
    s().runTerminal('ping 192.168.1.11');
    expect(s().lastResult?.success).toBe(false);
    expect(s().verifyStatus).toBe('ready');

    s().runTerminal('ping 192.168.1.88');
    expect(s().packet?.verify).toBe(true);
    s().packetArrived(s().packet!.id);

    expect(s().justCompleted).toBe(TIER0);
    expect(s().xp).toBe(100);
  });

  it('a failed ping before the config is right completes nothing', () => {
    start(TIER0); // PCs still unaddressed
    s().runTerminal('ping 192.168.1.11');

    expect(s().lastResult?.success).toBe(false);
    expect(s().packet?.verify).toBe(false); // ordinary failure feedback
    expect(s().verifyStatus).toBe('none');

    s().packetArrived(s().packet!.id);

    expect(s().justCompleted).toBeNull();
    expect(s().completedLabs).toEqual([]);
    expect(s().xp).toBe(0);
  });

  it('a different successful ping is just a ping', () => {
    start(TIER2);
    solveTier2();
    expect(s().verifyStatus).toBe('ready');

    s().runTerminal('ping 10.0.0.1'); // reaches PC-Red's own gateway, but isn't the declared run

    expect(s().lastResult?.success).toBe(true);
    expect(s().packet?.verify).toBe(false);
    expect(s().verifyStatus).toBe('ready'); // still waiting on the real one
    expect(s().justCompleted).toBeNull();

    s().runTerminal('ping 20.0.0.10');
    s().packetArrived(s().packet!.id);

    expect(s().justCompleted).toBe(TIER2);
    expect(s().xp).toBe(250);
  });

  it('ignores an arrival from a superseded run', () => {
    start(TIER0);
    solveTier0();
    s().runTerminal('ping 192.168.1.11');
    const stale = s().packet!.id;

    s().runTerminal('ping 192.168.1.11'); // a second run takes over the canvas
    s().packetArrived(stale);
    expect(s().justCompleted).toBeNull();

    s().packetArrived(s().packet!.id);
    expect(s().justCompleted).toBe(TIER0);
  });

  it('dismissing the banner mid-flight still settles the lab', () => {
    start(TIER0);
    solveTier0();
    s().runTerminal('ping 192.168.1.11');
    expect(s().verifyStatus).toBe('verifying');

    s().dismissResult(); // pulls the packet off the canvas before it lands

    expect(s().justCompleted).toBe(TIER0);
    expect(s().packet).toBeNull();
  });
});

describe('labs that declare no verifying ping', () => {
  it('still complete the moment their objectives do', () => {
    const plain: Lab = {
      ...ALL_LABS.find((l) => l.id === TIER0)!,
      id: 'plain-lab',
      verify: undefined,
      rewards: { xp: 42 },
    };
    start('plain-lab', [...ALL_LABS, plain]);

    solveTier0();

    expect(s().verifyStatus).toBe('none'); // never enters the middle state
    expect(s().justCompleted).toBe('plain-lab');
    expect(s().xp).toBe(42);
    expect(s().ambientPath).toBeNull(); // nothing was proven, so nothing pulses
  });
});

describe('the ambient link loop', () => {
  it('takes over the verified path once the burst lands, and stops on dismiss', () => {
    start(TIER0);
    solveTier0();
    s().runTerminal('ping 192.168.1.11');
    const path = s().packet!.path;
    expect(s().ambientPath).toBeNull(); // the burst is still in flight

    s().packetArrived(s().packet!.id);

    expect(s().ambientPath).toEqual(path);
    expect(s().packet).toBeNull(); // burst cleared, so nothing sits frozen under the loop

    s().dismissCompletion();
    expect(s().ambientPath).toBeNull();
    expect(s().justCompleted).toBeNull();
  });

  it('stops when the student moves on to the next lab', () => {
    start(TIER0);
    solveTier0();
    s().runTerminal('ping 192.168.1.11');
    s().packetArrived(s().packet!.id);
    expect(s().ambientPath).not.toBeNull();

    s().loadLab(TIER2);
    expect(s().ambientPath).toBeNull();
  });
});
