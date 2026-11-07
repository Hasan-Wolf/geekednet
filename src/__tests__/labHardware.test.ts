import { describe, expect, it } from 'vitest';
import type { Device, Link } from '../../engine/index.js';
import { cableCurve } from '../labScene.js';
import { useStore } from '../store.js';

describe('3D Ethernet connections', () => {
  const router: Device = {
    id: 'router', label: 'Router', kind: 'router', powered: true, x: 400, y: 200,
    interfaces: [{ id: 'wan', name: 'eth0' }, { id: 'lan', name: 'eth1' }],
  };
  const pc: Device = {
    id: 'pc', label: 'PC', kind: 'pc', powered: true, x: 120, y: 400,
    interfaces: [{ id: 'nic', name: 'eth0' }],
  };
  const link: Link = {
    id: 'cable', a: { deviceId: router.id, ifaceId: 'lan' }, b: { deviceId: pc.id, ifaceId: 'nic' },
  };

  it('keeps a plug in its assigned router jack when the other device moves across it', () => {
    const before = cableCurve(router, pc, link)!;
    const after = cableCurve(router, { ...pc, x: 700 }, link)!;
    expect(after.getPoint(0).distanceTo(before.getPoint(0))).toBeLessThan(1e-8);
    expect(after.getPoint(1).distanceTo(before.getPoint(1))).toBeGreaterThan(1);

    const otherJack = cableCurve(router, pc, { ...link, a: { ...link.a, ifaceId: 'wan' } })!;
    expect(otherJack.getPoint(0).distanceTo(before.getPoint(0))).toBeGreaterThan(0.2);
    expect(otherJack.getPoint(1).distanceTo(before.getPoint(1))).toBeLessThan(1e-8);
  });

  it('does not draw a plug for an interface that does not exist', () => {
    expect(cableCurve(router, pc, { ...link, a: { ...link.a, ifaceId: 'missing' } })).toBeNull();
  });
});

describe('workstation console', () => {
  it('uses the clicked PC even when the side terminal is bound to another device', () => {
    const state = () => useStore.getState();
    state().resetProgress();
    state().loadLab('tier0-first-ping.learn');
    state().setIfaceField('pc2', 'e0', 'ip', '192.168.1.21');
    state().setIfaceField('pc2', 'e0', 'mask', '255.255.255.0');
    state().runTerminal('ip addr');
    state().runTerminal('ip addr', 'pc2');
    const log = state().terminalLog;
    expect(log.filter(line => line.deviceId === 'pc2').some(line => line.text.includes('192.168.1.21'))).toBe(true);
    expect(log.filter(line => line.deviceId === 'pc1').some(line => line.text.includes('192.168.1.21'))).toBe(false);
    state().setPower('sw', false);
    state().runTerminal('ip addr', 'pc2');
    expect(state().terminalLog.some(line => line.deviceId === 'pc2' && line.text.includes('NO-CARRIER'))).toBe(true);
    state().runTerminal('clear', 'pc2');
    expect(state().terminalLog.some(line => line.deviceId === 'pc1')).toBe(true);
    expect(state().terminalLog.some(line => line.deviceId === 'pc2')).toBe(false);
  });
});
