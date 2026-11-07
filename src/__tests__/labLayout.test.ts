import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { TOPOLOGIES } from '../topologies/index.js';
import { benchCoordinates, BenchClick, devicePosition } from '../labLayout.js';
import { LabCameraDirector } from '../labCamera.js';

describe('3D topology readability', () => {
  for (const topology of TOPOLOGIES) {
    it(`${topology.id}: leaves space between hardware and retains drag coordinates`, () => {
      const before = structuredClone(topology.initialState);
      const devices = topology.initialState.devices;
      for (let i = 0; i < devices.length; i++) {
        const p = devicePosition(devices[i]);
        expect(benchCoordinates(p)).toEqual({ x: devices[i].x, y: devices[i].y });
        expect(p.x - 1.3).toBeGreaterThan(-8.9); expect(p.x + 1.3).toBeLessThan(8.9);
        expect(p.z - 0.65).toBeGreaterThan(-5.05); expect(p.z + 1.65).toBeLessThan(9.05);
        for (const other of devices.slice(i + 1)) expect(p.distanceTo(devicePosition(other))).toBeGreaterThan(3.8);
      }
      expect(topology.initialState).toEqual(before);
    });
    for (const aspect of [0.7, 1.2, 1.8]) {
      it(`${topology.id}: fits equipment inside a ${aspect} aspect overview`, () => {
        const camera = new PerspectiveCamera(39, aspect, 0.1, 120);
        const controls = { target: new Vector3(), enabled: true, update() { camera.lookAt(this.target); camera.updateMatrixWorld(); } };
        const director = new LabCameraDirector(camera, controls, true);
        director.reset(topology.initialState.devices, false);
        camera.updateProjectionMatrix();
        for (const device of topology.initialState.devices) {
          for (const x of [-1.3, 1.3]) for (const y of [0.1, 1.9]) for (const z of [-0.65, 1.65]) {
            const point = devicePosition(device).add(new Vector3(x, y, z)).project(camera);
            expect(Math.abs(point.x)).toBeLessThan(0.9);
            expect(Math.abs(point.y)).toBeLessThan(0.68);
            expect(point.z).toBeLessThan(1);
          }
        }
      });
    }
  }
});

describe('empty bench clicks', () => {
  it('accepts a click with tiny hand movement', () => {
    const click = new BenchClick(); click.begin(100, 100, 1); click.move(102, 101);
    expect(click.finish(1)).toBe(true);
  });
  it('does not zoom out after orbiting, even if the pointer returns to its start', () => {
    const click = new BenchClick(); click.begin(100, 100, 1); click.move(130, 120); click.move(100, 100);
    expect(click.finish(1)).toBe(false);
  });
  it('rejects cancelled gestures and unrelated pointers', () => {
    const click = new BenchClick(); click.begin(100, 100, 1); expect(click.finish(2)).toBe(false);
    click.begin(100, 100, 1); click.cancel(); expect(click.finish(1)).toBe(false);
  });
  it('does not reuse a completed click for another interaction', () => {
    const click = new BenchClick(); click.begin(100, 100, 1);
    expect(click.finish(1)).toBe(true); expect(click.finish(1)).toBe(false);
  });
});
