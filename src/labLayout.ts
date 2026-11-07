import { MathUtils, Vector3 } from 'three';
import type { Device } from '../engine/index.js';

// Keep the authored topology intact while giving full-size equipment more room.
export const LAB_COORDINATE_SCALE = 42;
export const devicePosition = (d: Pick<Device, 'x' | 'y'>) => new Vector3((d.x - 270) / LAB_COORDINATE_SCALE, 0, (d.y - 180) / LAB_COORDINATE_SCALE);

export function benchCoordinates(point: Pick<Vector3, 'x' | 'z'>) {
  return {
    x: Math.round(MathUtils.clamp(point.x, -270 / LAB_COORDINATE_SCALE, 7.6) * LAB_COORDINATE_SCALE + 270),
    y: Math.round(MathUtils.clamp(point.z, -180 / LAB_COORDINATE_SCALE, 8) * LAB_COORDINATE_SCALE + 180),
  };
}

/** Distinguish a deliberate empty-space click from orbiting or panning. */
export class BenchClick {
  private start: { x: number; y: number; pointerId: number } | null = null;
  private moved = false;
  begin(x: number, y: number, pointerId: number) { this.start = { x, y, pointerId }; this.moved = false; }
  move(x: number, y: number) { if (this.start && Math.hypot(x - this.start.x, y - this.start.y) > 5) this.moved = true; }
  finish(pointerId: number) { const clicked = this.start?.pointerId === pointerId && !this.moved; this.cancel(); return clicked; }
  cancel() { this.start = null; this.moved = false; }
}
