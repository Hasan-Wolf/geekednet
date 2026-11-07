import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import type { Device } from '../../engine/index.js';
import { LabCameraDirector, devicePosition } from '../labCamera.js';

const devices: Device[] = [
  { id: 'pc1', label: 'PC1', kind: 'pc', powered: true, x: 80, y: 180, interfaces: [{ id: 'e0', name: 'eth0', ip: '192.168.1.10', mask: '255.255.255.0' }] },
  { id: 'sw', label: 'Switch', kind: 'switch', powered: true, x: 270, y: 180, interfaces: [] },
  { id: 'pc2', label: 'PC2', kind: 'pc', powered: true, x: 460, y: 180, interfaces: [{ id: 'e0', name: 'eth0', ip: '192.168.1.11', mask: '255.255.255.0' }] },
];
function rig(reduced = false, aspect = 1.2) {
  const camera = new PerspectiveCamera(39, aspect, 0.1, 90);
  const controls = { target: new Vector3(), enabled: true, update() {} };
  const director = new LabCameraDirector(camera, controls, reduced); director.reset(devices, false);
  return { camera, controls, director };
}

describe('3D lab device selection', () => {
  it('moves into PC1 smoothly and releases orbit controls when finished', () => {
    const { director, controls, camera } = rig(); const initial = camera.position.clone();
    director.focus('pc1', devices, 0); director.tick(310);
    expect(camera.position.equals(initial)).toBe(false);
    expect(controls.enabled).toBe(false);
    director.tick(620);
    expect(controls.target.x).toBeCloseTo(devicePosition(devices[0]).x);
    expect(camera.position.distanceTo(controls.target)).toBeLessThan(5);
    expect(controls.enabled).toBe(true); expect(director.moving).toBe(false);
  });
  it('pulls back between PC1 and PC2, then focuses PC2', () => {
    const { director, controls, camera } = rig();
    director.focus('pc1', devices, 0); director.tick(620);
    const closeDistance = camera.position.distanceTo(controls.target);
    director.focus('pc2', devices, 1000); director.tick(1340);
    expect(camera.position.distanceTo(controls.target)).toBeGreaterThan(closeDistance * 2);
    expect(controls.target.x).toBeCloseTo(0);
    director.tick(1960);
    expect(controls.target.x).toBeCloseTo(devicePosition(devices[2]).x);
    expect(camera.position.distanceTo(controls.target)).toBeLessThan(5);
    expect(controls.enabled).toBe(true);
  });
  it('lets a rapid third selection replace a camera transition', () => {
    const { director, controls } = rig();
    director.focus('pc1', devices, 0); director.tick(200);
    director.focus('pc2', devices, 200); director.tick(400);
    director.focus('sw', devices, 400); director.tick(1500);
    expect(controls.target.x).toBeCloseTo(devicePosition(devices[1]).x);
    expect(controls.target.y).toBeCloseTo(0.5); expect(controls.enabled).toBe(true);
  });
  it('supports close-ups for every device kind without changing the lab', () => {
    const before = structuredClone(devices); const { director, controls } = rig(true);
    for (const kind of ['pc', 'switch', 'router', 'server', 'firewall', 'ap', 'cloud', 'laptop', 'hub', 'attacker'] as const) {
      const device = { ...devices[0], kind };
      director.focus(device.id, [device]);
      expect(controls.target.x).toBeCloseTo(devicePosition(device).x);
    }
    expect(devices).toEqual(before);
  });
  it('returns to the whole bench and permits refocusing the same selected device', () => {
    const { director, camera, controls } = rig();
    director.focus('pc1', devices, 0); director.tick(620);
    director.reset(devices, true, 1000); director.tick(1650);
    expect(camera.position.distanceTo(controls.target)).toBeGreaterThan(10);
    director.focus('pc1', devices, 2000); director.tick(2620);
    expect(camera.position.distanceTo(controls.target)).toBeLessThan(5);
  });
  it('honors reduced motion with immediate camera positioning', () => {
    const { director, controls } = rig(true);
    director.focus('pc2', devices, 0);
    expect(director.moving).toBe(false); expect(controls.enabled).toBe(true);
    expect(controls.target.x).toBeCloseTo(devicePosition(devices[2]).x);
  });
  it('fits the selected equipment on a narrow viewport', () => {
    const desktop = rig(true, 1.2); const phone = rig(true, 0.65);
    desktop.director.focus('pc1', devices); phone.director.focus('pc1', devices);
    expect(phone.camera.position.distanceTo(phone.controls.target)).toBeGreaterThan(desktop.camera.position.distanceTo(desktop.controls.target));
    expect(phone.controls.target).toEqual(desktop.controls.target);
  });
  it('ignores devices that no longer exist and allows manual interaction after cancel', () => {
    const { director, controls, camera } = rig(); const initial = camera.position.clone();
    director.focus('missing', devices, 0); expect(director.moving).toBe(false); expect(camera.position).toEqual(initial);
    director.focus('pc1', devices, 0); director.tick(100); director.cancel(); director.tick(1000);
    expect(controls.enabled).toBe(true); expect(director.moving).toBe(false);
  });
  it('zooms with the buttons while keeping the selected device centered', () => {
    const { director, camera, controls } = rig();
    director.focus('pc1', devices, 0); director.tick(620);
    const target = controls.target.clone(); const before = camera.position.distanceTo(target);
    director.zoom('in', 1000); director.tick(1180);
    expect(camera.position.distanceTo(target)).toBeLessThan(before);
    expect(controls.target).toEqual(target); expect(controls.enabled).toBe(true);
    director.zoom('out', 2000); director.tick(2180);
    expect(camera.position.distanceTo(target)).toBeCloseTo(before);
  });
  it('keeps repeated zoom button presses within usable camera limits', () => {
    const { director, camera, controls } = rig(true);
    for (let i = 0; i < 100; i++) director.zoom('in');
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(2.5);
    for (let i = 0; i < 100; i++) director.zoom('out');
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(70);
  });
});
