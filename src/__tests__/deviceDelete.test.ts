/**
 * Removing a device from the canvas, and taking it back.
 *
 * Deletion is now one keystroke, so the things that matter are that it takes
 * every cable with it (a link pointing at a device that is gone is a topology
 * the simulator cannot reason about), that it never blocks on a lab objective,
 * and that the undo puts back exactly what was there.
 */
import { describe, it, expect } from 'vitest';
import { ALL_LABS, useStore } from '../store.js';

const s = () => useStore.getState();

/** Fresh player, nothing banked, sitting on `labId`. */
function start(labId: string) {
  s().resetProgress();
  useStore.setState({ labs: ALL_LABS });
  s().loadLab(labId);
}

const ids = () => s().network.devices.map((d) => d.id);
const linkIds = () => s().network.links.map((l) => l.id);

/** Every linkId still referenced by an interface anywhere in the network. */
function referencedLinks(): string[] {
  const out: string[] = [];
  for (const d of s().network.devices) {
    for (const i of d.interfaces) if (i.linkId) out.push(i.linkId);
  }
  return [...new Set(out)].sort();
}

/** No interface may point at a cable that is not in `links`. */
function expectNoDanglingLinks() {
  const live = new Set(linkIds());
  for (const ref of referencedLinks()) {
    expect(live.has(ref), `interface points at removed cable ${ref}`).toBe(true);
  }
  for (const link of s().network.links) {
    for (const end of [link.a, link.b]) {
      const d = s().network.devices.find((dev) => dev.id === end.deviceId);
      expect(d, `link ${link.id} points at missing device ${end.deviceId}`).toBeDefined();
    }
  }
}

describe('deleting a device in a lab', () => {
  it('takes every attached cable with it', () => {
    start('tier0-first-ping.learn');
    expect(ids()).toEqual(['pc1', 'pc2', 'sw']);
    expect(linkIds()).toEqual(['l1', 'l2']);

    s().removeDevice('sw');

    expect(ids()).toEqual(['pc1', 'pc2']);
    expect(linkIds()).toEqual([]); // the switch owned both
    expectNoDanglingLinks();
  });

  it('clears the config panel when the deleted device was the selected one', () => {
    start('tier0-first-ping.learn');
    s().selectDevice('pc2');
    s().removeDevice('pc2');
    expect(s().selectedDeviceId).toBeNull();
  });

  it('leaves a different selection alone', () => {
    start('tier0-first-ping.learn');
    s().selectDevice('pc1');
    s().removeDevice('pc2');
    expect(s().selectedDeviceId).toBe('pc1');
  });

  it('moves the terminal off a device that no longer exists', () => {
    start('tier0-first-ping.learn');
    useStore.setState({ terminalDeviceId: 'pc2' });
    s().removeDevice('pc2');
    expect(s().terminalDeviceId).not.toBe('pc2');
    expect(ids()).toContain(s().terminalDeviceId);
  });

  it('un-greens an objective that depended on it rather than refusing', () => {
    start('tier0-first-ping.learn');
    s().setIfaceField('pc1', 'e0', 'ip', '192.168.1.10');
    s().setIfaceField('pc1', 'e0', 'mask', '255.255.255.0');
    s().setIfaceField('pc2', 'e0', 'ip', '192.168.1.11');
    s().setIfaceField('pc2', 'e0', 'mask', '255.255.255.0');
    expect(s().objectiveResults.every((o) => o.complete)).toBe(true);
    expect(s().verifyStatus).toBe('ready');

    s().removeDevice('pc2');

    // The lab is simply unsolved again — the deletion goes through either way.
    expect(ids()).not.toContain('pc2');
    expect(s().objectiveResults.map((o) => o.complete)).toEqual([true, false, false]);
    expect(s().verifyStatus).toBe('none');
    expect(s().completedLabs).toEqual([]);
  });

  it('offers the deletion back, named as the student sees it', () => {
    start('tier0-first-ping.learn');
    expect(s().lastDeleted).toBeNull();
    s().removeDevice('pc2');
    expect(s().lastDeleted?.label).toBe('PC2');
    expect(s().lastDeleted?.links.map((l) => l.id)).toEqual(['l2']);
  });

  it('does not raise an offer for a device that was not there', () => {
    start('tier0-first-ping.learn');
    s().removeDevice('ghost');
    expect(s().lastDeleted).toBeNull();
    expect(ids()).toEqual(['pc1', 'pc2', 'sw']);
  });
});

describe('undoing the last deletion', () => {
  it('puts the device and its cables back exactly as they were', () => {
    start('tier0-first-ping.learn');
    s().setIfaceField('pc2', 'e0', 'ip', '192.168.1.11');
    s().setIfaceField('pc2', 'e0', 'mask', '255.255.255.0');
    const before = JSON.parse(JSON.stringify(s().network));

    s().removeDevice('pc2');
    expect(ids()).not.toContain('pc2');

    s().undoDelete();

    // Same devices and links, and the address the student had typed survives.
    expect(ids().sort()).toEqual(before.devices.map((d: { id: string }) => d.id).sort());
    expect(linkIds().sort()).toEqual(['l1', 'l2']);
    const pc2 = s().network.devices.find((d) => d.id === 'pc2')!;
    expect(pc2.interfaces[0].ip).toBe('192.168.1.11');
    expect(pc2.interfaces[0].linkId).toBe('l2');
    expectNoDanglingLinks();
  });

  it('re-greens the objectives the deletion broke', () => {
    start('tier0-first-ping.learn');
    s().setIfaceField('pc1', 'e0', 'ip', '192.168.1.10');
    s().setIfaceField('pc1', 'e0', 'mask', '255.255.255.0');
    s().setIfaceField('pc2', 'e0', 'ip', '192.168.1.11');
    s().setIfaceField('pc2', 'e0', 'mask', '255.255.255.0');

    s().removeDevice('sw'); // the switch both PCs talk through
    expect(s().objectiveResults.map((o) => o.complete)).toEqual([true, true, false]);

    s().undoDelete();

    expect(s().objectiveResults.every((o) => o.complete)).toBe(true);
    expect(s().verifyStatus).toBe('ready');
  });

  it('selects what it restored, and clears the offer', () => {
    start('tier0-first-ping.learn');
    s().removeDevice('pc2');
    s().undoDelete();
    expect(s().selectedDeviceId).toBe('pc2');
    expect(s().lastDeleted).toBeNull();
  });

  it('is a no-op when there is nothing to take back', () => {
    start('tier0-first-ping.learn');
    const before = ids();
    s().undoDelete();
    expect(ids()).toEqual(before);
  });

  it('only remembers the most recent deletion', () => {
    start('tier0-first-ping.learn');
    s().removeDevice('pc1');
    s().removeDevice('pc2');
    expect(s().lastDeleted?.label).toBe('PC2');

    s().undoDelete();

    expect(ids()).toContain('pc2');
    expect(ids()).not.toContain('pc1'); // single level, by design
    expectNoDanglingLinks();
  });

  it('gives up a cable whose port has been re-used, without dangling it', () => {
    start('tier0-first-ping.learn');
    s().removeDevice('pc2'); // frees switch port p2
    s().toggleConnectMode();
    s().addDevice('pc', 300, 300);
    const fresh = ids().find((id) => !['pc1', 'sw'].includes(id))!;
    s().clickDeviceForConnect(fresh);
    s().clickDeviceForConnect('sw'); // takes p2

    s().undoDelete();

    // PC2 is back but unplugged: its old port belongs to the new PC now.
    const pc2 = s().network.devices.find((d) => d.id === 'pc2')!;
    expect(pc2).toBeDefined();
    expect(pc2.interfaces[0].linkId).toBeNull();
    expectNoDanglingLinks();
  });

  it('is dropped when the student moves to another lab', () => {
    start('tier0-first-ping.learn');
    s().removeDevice('pc2');
    expect(s().lastDeleted).not.toBeNull();

    s().loadLab('sandbox');

    // Restoring PC2 into a different topology would drop in a stranger.
    expect(s().lastDeleted).toBeNull();
    s().undoDelete();
    expect(s().network.devices).toEqual([]);
  });

  it('is dropped when the lab is reset', () => {
    start('tier0-first-ping.learn');
    s().removeDevice('pc2');
    s().resetLab();
    expect(s().lastDeleted).toBeNull();
    expect(ids()).toEqual(['pc1', 'pc2', 'sw']);
  });

  it('can be dismissed without acting on it', () => {
    start('tier0-first-ping.learn');
    s().removeDevice('pc2');
    s().dismissUndo();
    expect(s().lastDeleted).toBeNull();
    expect(ids()).not.toContain('pc2');
  });
});

describe('deleting in a topology the student built from nothing', () => {
  it('removes a hand-built device and its cables, and takes it back', () => {
    start('sandbox');
    expect(s().network.devices).toEqual([]);

    s().addDevice('switch', 300, 100);
    s().addDevice('pc', 100, 300);
    s().addDevice('pc', 500, 300);
    const [sw, a, b] = ids();
    s().toggleConnectMode();
    s().clickDeviceForConnect(a);
    s().clickDeviceForConnect(sw);
    s().clickDeviceForConnect(b);
    s().clickDeviceForConnect(sw);
    s().toggleConnectMode();
    expect(linkIds()).toHaveLength(2);

    s().removeDevice(sw);

    expect(ids().sort()).toEqual([a, b].sort());
    expect(linkIds()).toEqual([]);
    expectNoDanglingLinks();

    s().undoDelete();

    expect(ids()).toContain(sw);
    expect(linkIds()).toHaveLength(2);
    expectNoDanglingLinks();
  });

  it('empties the canvas one device at a time without dangling anything', () => {
    start('sandbox');
    s().addDevice('switch', 300, 100);
    s().addDevice('pc', 100, 300);
    s().addDevice('pc', 500, 300);
    const [sw, a, b] = ids();
    s().toggleConnectMode();
    s().clickDeviceForConnect(a);
    s().clickDeviceForConnect(sw);
    s().clickDeviceForConnect(b);
    s().clickDeviceForConnect(sw);
    s().toggleConnectMode();

    for (const id of [a, sw, b]) {
      s().removeDevice(id);
      expectNoDanglingLinks();
    }
    expect(s().network.devices).toEqual([]);
    expect(s().network.links).toEqual([]);
  });
});
