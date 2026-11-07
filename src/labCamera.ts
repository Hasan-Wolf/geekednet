import { Box3, MathUtils, PerspectiveCamera, Vector3 } from 'three';
import type { Device } from '../engine/index.js';
import { devicePosition } from './labLayout.js';

export { devicePosition } from './labLayout.js';
type View = 'orbit' | 'top';
interface Pose { position: Vector3; target: Vector3 }
interface CameraControls { target: Vector3; enabled: boolean; update: () => unknown }
interface Leg { from: Pose; to: Pose; start: number; duration: number }

/** The camera only observes devices. It never changes addressing or topology. */
export class LabCameraDirector {
  private legs: Leg[] = [];
  private focusedId: string | null = null;
  private view: View = 'orbit';

  constructor(private camera: PerspectiveCamera, private controls: CameraControls, private reducedMotion = false) {}

  private current(): Pose { return { position: this.camera.position.clone(), target: this.controls.target.clone() }; }
  private overview(devices: Device[]): Pose {
    const bounds = new Box3();
    for (const device of devices) {
      const p = devicePosition(device);
      bounds.expandByPoint(p.clone().add(new Vector3(-1.3, 0.1, -0.65)));
      bounds.expandByPoint(p.clone().add(new Vector3(1.3, 1.9, 1.65)));
    }
    if (!devices.length) bounds.set(new Vector3(-4, 0.1, -2), new Vector3(4, 1.9, 3));
    const target = bounds.getCenter(new Vector3());
    const direction = (this.view === 'top' ? new Vector3(0, 1, 0.001) : new Vector3(0.1, 0.92, 1)).normalize();
    const right = new Vector3().crossVectors(new Vector3(0, 1, 0), direction).normalize();
    const up = new Vector3().crossVectors(direction, right).normalize();
    const tangent = Math.tan(this.camera.fov * Math.PI / 360);
    let distance = 10.2;
    // Fit hardware and nameplates, reserving room for the controls above/below.
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      const offset = new Vector3(x, y, z).sub(target);
      distance = Math.max(distance, Math.abs(offset.dot(right)) / (tangent * this.camera.aspect * 0.88) + offset.dot(direction), Math.abs(offset.dot(up)) / (tangent * 0.65) + offset.dot(direction));
    }
    return { target, position: target.clone().add(direction.multiplyScalar(distance * 1.04)) };
  }
  private closeUp(device: Device): Pose {
    const target = devicePosition(device); target.y = ['pc', 'server', 'laptop', 'router', 'attacker'].includes(device.kind) ? 0.78 : 0.5;
    const scale = Math.max(1, 1.02 / this.camera.aspect);
    const offset = this.view === 'top' ? new Vector3(0, 4.6 * scale, 0.01) : new Vector3(1.25, 1.65, 3.55).multiplyScalar(scale);
    return { target, position: target.clone().add(offset) };
  }
  private apply(pose: Pose) { this.camera.position.copy(pose.position); this.controls.target.copy(pose.target); this.controls.update(); }
  private travel(poses: Array<{ pose: Pose; duration: number }>, now: number) {
    this.legs = [];
    if (this.reducedMotion) { this.apply(poses[poses.length - 1].pose); this.controls.enabled = true; return; }
    let from = this.current(); let start = now;
    for (const { pose, duration } of poses) { this.legs.push({ from, to: pose, start, duration }); from = pose; start += duration; }
    this.controls.enabled = false;
  }
  focus(id: string, devices: Device[], now = performance.now()) {
    const device = devices.find(d => d.id === id); if (!device) return;
    const switching = this.focusedId !== null && this.focusedId !== id;
    this.focusedId = id;
    this.travel([...(switching ? [{ pose: this.overview(devices), duration: 340 }] : []), { pose: this.closeUp(device), duration: 620 }], now);
  }
  reset(devices: Device[], animate = true, now = performance.now()) {
    this.focusedId = null;
    if (animate) this.travel([{ pose: this.overview(devices), duration: 650 }], now);
    else { this.cancel(); this.apply(this.overview(devices)); }
  }
  setView(view: View, devices: Device[]) { this.view = view; this.reset(devices); }
  zoom(direction: 'in' | 'out', now = performance.now()) {
    const pose = this.current();
    const offset = pose.position.clone().sub(pose.target);
    const distance = MathUtils.clamp(offset.length() * (direction === 'in' ? 0.8 : 1.25), 2.5, 70);
    pose.position.copy(pose.target).add(offset.setLength(distance));
    this.travel([{ pose, duration: 180 }], now);
  }
  reframe(devices: Device[]) {
    if (this.focusedId && devices.some(d => d.id === this.focusedId)) this.focus(this.focusedId, devices);
    else this.reset(devices, false);
  }
  cancel() { this.legs = []; this.controls.enabled = true; }
  tick(now: number) {
    if (!this.legs.length) return;
    while (this.legs.length && now >= this.legs[0].start + this.legs[0].duration) { this.apply(this.legs[0].to); this.legs.shift(); }
    const leg = this.legs[0];
    if (!leg) { this.controls.enabled = true; return; }
    const t = Math.max(0, Math.min(1, (now - leg.start) / leg.duration));
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    this.apply({ position: leg.from.position.clone().lerp(leg.to.position, eased), target: leg.from.target.clone().lerp(leg.to.target, eased) });
    if (now >= this.legs[this.legs.length - 1].start + this.legs[this.legs.length - 1].duration) this.controls.enabled = true;
  }
  get moving() { return this.legs.length > 0; }
}
