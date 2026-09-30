/**
 * Learn Topology, held to its two promises.
 *
 * The first is that every shape arrives *working*: the point of a demo is that
 * the student loads it and pings, so "devices placed, cables run, addresses
 * assigned" is a testable claim, and it is tested through the real engine rather
 * than by eyeballing the JSON.
 *
 * The second is that a demo is not a lab. It must be impossible to earn XP, a
 * badge, an unlock, a mission tick or a win bar from one, no matter what happens
 * on its canvas — including the sign-off ping of whichever mission the student
 * last had open.
 */
import { describe, it, expect } from 'vitest';
import { getDevice, ping, type Device, type NetworkState } from '../../engine/index.js';
import {
  BOX_H,
  LABEL_H,
  NODE_TEXT_H,
  NODE_W,
  center,
  portLabel,
} from '../components/Canvas.js';
import { missionProgress } from '../progress.js';
import { useStore } from '../store.js';
import {
  TOPOLOGIES,
  TopologySchemaError,
  demoPing,
  getTopology,
  validateTopology,
} from '../topologies/index.js';

const s = () => useStore.getState();

const HOST_KINDS = new Set(['pc', 'laptop', 'server']);
const hosts = (net: NetworkState): Device[] => net.devices.filter((d) => HOST_KINDS.has(d.kind));

/** Every (sender, target-address) pair of addressed hosts in a topology. */
function hostPairs(net: NetworkState): Array<[Device, Device, string]> {
  const addressed = hosts(net).filter((d) => d.interfaces.some((i) => i.ip));
  const out: Array<[Device, Device, string]> = [];
  for (const from of addressed) {
    for (const to of addressed) {
      if (from.id === to.id) continue;
      out.push([from, to, to.interfaces.find((i) => i.ip)!.ip!]);
    }
  }
  return out;
}

describe('the registry', () => {
  it('ships the seven shapes, left to right, in teaching order', () => {
    expect(TOPOLOGIES.map((t) => t.id)).toEqual([
      'star',
      'bus',
      'ring',
      'full-mesh',
      'partial-mesh',
      'tree',
      'hybrid',
    ]);
  });

  it('gives every shape a name, a one-liner and a status badge', () => {
    for (const t of TOPOLOGIES) {
      expect(t.name, t.id).toBeTruthy();
      expect(t.oneLine, t.id).toBeTruthy();
      expect(t.statusLabel, t.id).toBeTruthy();
      expect(['current', 'specialized', 'historical'], t.id).toContain(t.status);
    }
  });

  it('gives Pip every section to render, per shape', () => {
    for (const { id, explanation } of TOPOLOGIES) {
      expect(explanation.whatItIs, id).toBeTruthy();
      expect(explanation.howDataTravels, id).toBeTruthy();
      expect(explanation.whereUsedToday, id).toBeTruthy();
      expect(explanation.goodToKnow, id).toBeTruthy();
      expect(explanation.advantages.length, id).toBeGreaterThan(0);
      expect(explanation.drawbacks.length, id).toBeGreaterThan(0);
    }
  });

  // The data file is hand-authored, so the cheap typos are the ones worth
  // catching loudly: a cable pointing at a port that isn't there draws nothing,
  // and a port holding a stale linkId makes the engine think it is plugged in.
  it('refuses a cable that names a port the device does not have', () => {
    const broken = structuredClone(TOPOLOGIES[0]) as unknown as Record<string, unknown>;
    const net = broken.initialState as NetworkState;
    net.links[0].a.ifaceId = 'nope';
    expect(() => validateTopology({ ...raw(TOPOLOGIES[0]), initialState: net })).toThrow(
      TopologySchemaError,
    );
  });

  it('refuses a status it has no badge for', () => {
    expect(() => validateTopology({ ...raw(TOPOLOGIES[0]), status: 'trendy' })).toThrow(
      TopologySchemaError,
    );
  });
});

/** Back to the raw entry shape `validateTopology` consumes. */
function raw(t: (typeof TOPOLOGIES)[number]): Record<string, unknown> {
  return {
    id: t.id,
    name: t.name,
    oneLine: t.oneLine,
    status: t.status,
    statusLabel: t.statusLabel,
    ...t.explanation,
    initialState: t.initialState,
  };
}

describe('every shape arrives working', () => {
  it.each(TOPOLOGIES.map((t) => [t.id, t] as const))('%s is fully addressed', (_id, topology) => {
    for (const host of hosts(topology.initialState)) {
      const iface = host.interfaces[0];
      expect(iface.ip, `${host.label} has no address`).toBeTruthy();
      expect(iface.mask, `${host.label} has no mask`).toBeTruthy();
      expect(iface.linkId, `${host.label} is not cabled`).toBeTruthy();
      expect(host.powered, `${host.label} is powered off`).toBe(true);
    }
  });

  it.each(TOPOLOGIES.map((t) => [t.id, t] as const))(
    '%s carries a ping between every pair of hosts',
    (_id, topology) => {
      const pairs = hostPairs(topology.initialState);
      expect(pairs.length, 'a demo needs two addressed hosts to ping between').toBeGreaterThan(0);
      for (const [from, to, ip] of pairs) {
        const result = ping(topology.initialState, from.id, ip);
        expect(result.success, `${from.label} → ${to.label} (${ip}): ${result.reason}`).toBe(true);
      }
    },
  );

  it.each(TOPOLOGIES.map((t) => [t.id, t] as const))(
    '%s suggests a ping that works',
    (_id, topology) => {
      const suggestion = demoPing(topology.initialState);
      expect(suggestion, 'no suggested ping').not.toBeNull();
      const result = ping(topology.initialState, suggestion!.from.id, suggestion!.toIp);
      expect(result.success, result.reason).toBe(true);
    },
  );

  // The explanation makes a numeric claim about this one — "with four devices
  // that's six cables" — and the demo is meant to be that picture. A mesh that
  // quietly grew to eight nodes would also be an unreadable tangle on canvas.
  it('keeps the full mesh small enough to count the cables', () => {
    const mesh = getTopology('full-mesh')!.initialState;
    const nodes = mesh.devices.filter((d) => !HOST_KINDS.has(d.kind));
    expect(nodes.length).toBeLessThanOrEqual(5);
    // n(n-1)/2 — every node cabled to every other, and nothing missing.
    const between = mesh.links.filter(
      (l) =>
        nodes.some((n) => n.id === l.a.deviceId) && nodes.some((n) => n.id === l.b.deviceId),
    );
    expect(between.length).toBe((nodes.length * (nodes.length - 1)) / 2);
  });

  it('fits every shape inside a canvas the student can see', () => {
    for (const t of TOPOLOGIES) {
      for (const d of t.initialState.devices) {
        expect(d.x, `${t.id}/${d.label} x`).toBeGreaterThanOrEqual(0);
        // Clear of the canvas toolbar, which floats over the top-left corner.
        expect(d.y, `${t.id}/${d.label} y`).toBeGreaterThanOrEqual(60);
        expect(d.x + NODE_W, `${t.id}/${d.label} right edge`).toBeLessThanOrEqual(CANVAS_W);
        expect(d.y + FOOT_H, `${t.id}/${d.label} bottom edge`).toBeLessThanOrEqual(CANVAS_H);
      }
    }
  });

  /**
   * The layout, checked against the renderer that draws it.
   *
   * Placement is data, and this renderer has an opinion about it: a port label
   * sits a fixed distance out from its node but never past 42% of the cable, so
   * a cable that is too short drags its own labels back on top of the devices —
   * and a near-vertical one needs ~200px, because a node's footprint includes
   * the name and address printed under it. Both failures look like a broken
   * simulator rather than a cramped diagram, and neither shows up in a ping
   * test, so the geometry is pinned here using the canvas's own `center` and
   * `portLabel`. Adding a topology means satisfying this, not guessing at it.
   */
  it.each(TOPOLOGIES.map((t) => [t.id, t] as const))(
    '%s draws without anything landing on top of anything else',
    (_id, topology) => {
      const net = topology.initialState;
      const byId = new Map(net.devices.map((d) => [d.id, d]));
      const problems: string[] = [];

      for (let i = 0; i < net.devices.length; i += 1) {
        for (let j = i + 1; j < net.devices.length; j += 1) {
          const [a, b] = [net.devices[i], net.devices[j]];
          if (hits(footprint(a), footprint(b))) problems.push(`${a.label} overlaps ${b.label}`);
        }
      }

      const pills = net.links.flatMap((link) => {
        const a = byId.get(link.a.deviceId)!;
        const b = byId.get(link.b.deviceId)!;
        const nameA = a.interfaces.find((i) => i.id === link.a.ifaceId)!.name;
        const nameB = b.interfaces.find((i) => i.id === link.b.ifaceId)!.name;
        return [
          { owner: a.label, name: nameA, rect: pillRect(portLabel(link.id, a, b, nameA)) },
          { owner: b.label, name: nameB, rect: pillRect(portLabel(link.id, b, a, nameB)) },
        ];
      });

      for (let i = 0; i < pills.length; i += 1) {
        for (let j = i + 1; j < pills.length; j += 1) {
          if (hits(pills[i].rect, pills[j].rect)) {
            problems.push(
              `port labels collide: ${pills[i].owner}/${pills[i].name} and ${pills[j].owner}/${pills[j].name}`,
            );
          }
        }
      }
      for (const pill of pills) {
        for (const d of net.devices) {
          if (hits(pill.rect, iconBox(d)) || hits(pill.rect, labelBox(d))) {
            problems.push(`port label ${pill.owner}/${pill.name} sits on ${d.label}`);
          }
        }
      }
      for (const link of net.links) {
        const a = byId.get(link.a.deviceId)!;
        const b = byId.get(link.b.deviceId)!;
        for (const d of net.devices) {
          if (d.id === a.id || d.id === b.id) continue;
          if (crosses(center(a), center(b), footprint(d))) {
            problems.push(`cable ${a.label}→${b.label} runs through ${d.label}`);
          }
        }
      }

      expect(problems).toEqual([]);
    },
  );
});

// ---- canvas geometry helpers, built on the renderer's own numbers ----------

/** The narrowest canvas worth designing for: a 1280px window, palette and side
 *  panel at their defaults. Height is the same window minus the topbar. */
const CANVAS_W = 660;
const CANVAS_H = 600;
const FOOT_H = BOX_H + NODE_TEXT_H;

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Everything a node occupies: its box plus the name and address under it. */
const footprint = (d: Device): Rect => ({
  x0: d.x,
  y0: d.y,
  x1: d.x + NODE_W,
  y1: d.y + FOOT_H,
});
const iconBox = (d: Device): Rect => ({ x0: d.x, y0: d.y, x1: d.x + NODE_W, y1: d.y + BOX_H });
/** The name and address are centred in the node's width; the margins either
 *  side are empty, and a pill clipping those is invisible. */
const labelBox = (d: Device): Rect => ({
  x0: d.x + 13,
  y0: d.y + BOX_H,
  x1: d.x + NODE_W - 13,
  y1: d.y + FOOT_H,
});
const pillRect = (l: { x: number; y: number; w: number }): Rect => ({
  x0: l.x - l.w / 2,
  y0: l.y - LABEL_H / 2,
  x1: l.x + l.w / 2,
  y1: l.y + LABEL_H / 2,
});

const hits = (a: Rect, b: Rect): boolean =>
  a.x0 < b.x1 - 1 && b.x0 < a.x1 - 1 && a.y0 < b.y1 - 1 && b.y0 < a.y1 - 1;

/** Does the straight run from p to q pass through r? Sampled, which is ample at
 *  canvas scale and far simpler than a clipper. */
function crosses(p: { x: number; y: number }, q: { x: number; y: number }, r: Rect): boolean {
  for (let i = 1; i < 240; i += 1) {
    const t = i / 240;
    const x = p.x + (q.x - p.x) * t;
    const y = p.y + (q.y - p.y) * t;
    if (x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1) return true;
  }
  return false;
}

describe('a demo is not a lab', () => {
  it('loads a shape onto the canvas, built and addressed', () => {
    s().resetProgress();
    s().enterTopologyMode();
    expect(s().topologyMode).toBe(true);
    expect(s().topologyId).toBeNull();
    expect(s().network.devices).toHaveLength(0);

    s().loadTopology('ring');
    const ring = getTopology('ring')!;
    expect(s().topologyId).toBe('ring');
    expect(s().network.devices).toHaveLength(ring.initialState.devices.length);
    expect(s().network.links).toHaveLength(ring.initialState.links.length);
    // The shell opens on a host that can ping straight away.
    expect(HOST_KINDS.has(getDevice(s().network, s().terminalDeviceId!)!.kind)).toBe(true);
  });

  it('never scores anything, whatever happens on the canvas', () => {
    s().resetProgress();
    const before = {
      xp: s().xp,
      badges: s().earnedBadges,
      unlocked: s().unlocked,
      completed: s().completedLabs,
    };

    s().enterTopologyMode();
    s().loadTopology('star');
    const suggestion = demoPing(s().network)!;
    s().selectDevice(suggestion.from.id);
    useStore.setState({ terminalDeviceId: suggestion.from.id });
    s().runTerminal(`ping ${suggestion.toIp}`);

    expect(s().lastResult?.success).toBe(true);
    expect(s().objectiveResults).toEqual([]);
    expect(s().verifyStatus).toBe('none');
    expect(s().justCompleted).toBeNull();
    expect(s().xp).toBe(before.xp);
    expect(s().earnedBadges).toEqual(before.badges);
    expect(s().unlocked).toEqual(before.unlocked);
    expect(s().completedLabs).toEqual(before.completed);
  });

  // The nastiest case: the student is one ping away from finishing mission one,
  // switches to a demo, and runs that exact ping there. The demo's canvas has
  // nothing to do with the mission, so the mission must not move.
  it('does not let a demo fire a lab’s sign-off ping', () => {
    s().resetProgress();
    s().loadLab('tier0-first-ping.learn');
    const { setIfaceField } = s();
    setIfaceField('pc1', 'e0', 'ip', '192.168.1.11');
    setIfaceField('pc1', 'e0', 'mask', '255.255.255.0');
    setIfaceField('pc2', 'e0', 'ip', '192.168.1.12');
    setIfaceField('pc2', 'e0', 'mask', '255.255.255.0');
    expect(s().verifyStatus).toBe('ready');

    // The star demo happens to use the very same addresses on pc1 / pc2.
    s().enterTopologyMode();
    s().loadTopology('star');
    useStore.setState({ terminalDeviceId: 'pc1' });
    s().runTerminal('ping 192.168.1.12');
    s().packetArrived(s().packet!.id);

    expect(s().justCompleted).toBeNull();
    expect(s().xp).toBe(0);
    expect(s().completedLabs).toEqual([]);
  });

  it('leaves the mission counter alone', () => {
    s().resetProgress();
    const missions = missionProgress(s().labs, s().unlocked, s().completedLabs);
    s().enterTopologyMode();
    s().loadTopology('tree');
    expect(missionProgress(s().labs, s().unlocked, s().completedLabs)).toEqual(missions);
    // Demos are not in the lab registry at all, so nothing can count them.
    expect(s().labs.some((l) => TOPOLOGIES.some((t) => t.id === l.id))).toBe(false);
  });

  it('goes back to the bar list, and resets a shape the student broke', () => {
    s().enterTopologyMode();
    s().loadTopology('bus');
    const original = s().network.devices.length;

    s().removeDevice(s().network.devices[0].id);
    expect(s().network.devices.length).toBe(original - 1);

    s().resetTopology();
    expect(s().network.devices.length).toBe(original);
    expect(s().network).toEqual(getTopology('bus')!.initialState);

    s().backToTopologies();
    expect(s().topologyId).toBeNull();
    expect(s().topologyMode).toBe(true);
    expect(s().network.devices).toHaveLength(0);
  });

  it('is left behind the moment a lab is opened', () => {
    s().enterTopologyMode();
    s().loadTopology('hybrid');
    s().loadLab('tier0-first-ping.learn');
    expect(s().topologyMode).toBe(false);
    expect(s().topologyId).toBeNull();
    expect(s().objectiveResults.length).toBeGreaterThan(0);
  });
});

describe('the idle loop in ungraded spaces', () => {
  /** Run the suggested ping and let its packet land. */
  function pingAndLand(from: string, toIp: string) {
    useStore.setState({ terminalDeviceId: from });
    s().runTerminal(`ping ${toIp}`);
    const packet = s().packet;
    if (packet) s().packetArrived(packet.id);
  }

  it('starts after a successful ping in a topology demo', () => {
    s().resetProgress();
    s().enterTopologyMode();
    s().loadTopology('star');
    expect(s().ambientPath).toBeNull();

    const suggestion = demoPing(s().network)!;
    pingAndLand(suggestion.from.id, suggestion.toIp);
    expect(s().ambientPath).toEqual([suggestion.from.id, suggestion.to.id]);
    // The one-shot packet gives way to the loop rather than sitting under it.
    expect(s().packet).toBeNull();
  });

  it('starts after a successful ping in the sandbox', () => {
    s().resetProgress();
    s().loadLab('sandbox');
    s().addDevice('pc', 40, 40);
    s().addDevice('pc', 300, 40);
    const [a, b] = s().network.devices;
    s().clickDeviceForConnect(a.id);
    s().clickDeviceForConnect(b.id);
    s().setIfaceField(a.id, 'e0', 'ip', '10.0.0.1');
    s().setIfaceField(a.id, 'e0', 'mask', '255.255.255.0');
    s().setIfaceField(b.id, 'e0', 'ip', '10.0.0.2');
    s().setIfaceField(b.id, 'e0', 'mask', '255.255.255.0');

    pingAndLand(a.id, '10.0.0.2');
    expect(s().lastResult?.success).toBe(true);
    expect(s().ambientPath).toEqual([a.id, b.id]);
  });

  it('does not start on a ping that failed', () => {
    s().resetProgress();
    s().enterTopologyMode();
    s().loadTopology('star');
    pingAndLand(demoPing(s().network)!.from.id, '10.99.99.99');
    expect(s().lastResult?.success).toBe(false);
    expect(s().ambientPath).toBeNull();
  });

  it('retires when the student re-wires, and survives a drag', () => {
    s().resetProgress();
    s().enterTopologyMode();
    s().loadTopology('star');
    const suggestion = demoPing(s().network)!;
    pingAndLand(suggestion.from.id, suggestion.toIp);
    expect(s().ambientPath).not.toBeNull();

    // Dragging a device re-routes the loop onto its new cables; it must not
    // stop it. Pulling a cable is the opposite: the proven path may be gone.
    s().moveDevice(suggestion.from.id, 120, 120);
    expect(s().ambientPath).not.toBeNull();

    s().removeLink(s().network.links[0].id);
    expect(s().ambientPath).toBeNull();
  });
});
