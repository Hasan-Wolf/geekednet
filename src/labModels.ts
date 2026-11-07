import * as T from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { Device, DeviceKind, LinkHealth } from '../engine/index.js';

const metal = () => new T.MeshStandardMaterial({ color: 0x4b5b69, metalness: 0.78, roughness: 0.3 });
const dark = () => new T.MeshStandardMaterial({ color: 0x172330, metalness: 0.6, roughness: 0.34 });
const rubber = () => new T.MeshStandardMaterial({ color: 0x060a10, roughness: 0.86 });
const glow = (color: number) => new T.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 2.2, roughness: 0.3 });

function box(g: T.Group, size: number[], pos: number[], material: T.Material, radius = 0.025) {
  const mesh = new T.Mesh(new RoundedBoxGeometry(size[0], size[1], size[2], 2, radius), material);
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  g.add(mesh);
  return mesh;
}

function cylinder(g: T.Group, r: number, h: number, pos: number[], material: T.Material) {
  const mesh = new T.Mesh(new T.CylinderGeometry(r, r, h, 12), material);
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.castShadow = true;
  g.add(mesh);
  return mesh;
}

export function textTexture(lines: string[], title = 'GEEKEDNET // SYSTEM') {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 300;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#050e17'; ctx.fillRect(0, 0, 512, 300);
  const gradient = ctx.createLinearGradient(0, 0, 512, 300);
  gradient.addColorStop(0, '#102d3c'); gradient.addColorStop(1, '#070d19');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 512, 300);
  ctx.fillStyle = '#39d5e8'; ctx.font = 'bold 17px monospace'; ctx.fillText(title, 24, 36);
  ctx.strokeStyle = '#234d5d'; ctx.beginPath(); ctx.moveTo(24, 52); ctx.lineTo(488, 52); ctx.stroke();
  ctx.font = '15px monospace';
  lines.forEach((line, i) => { ctx.fillStyle = i === 0 ? '#d2e9ef' : '#729cac'; ctx.fillText(line, 24, 90 + i * 32); });
  ctx.fillStyle = '#2cd7e8'; ctx.fillRect(24, 251, 9, 16);
  ctx.fillStyle = '#335461'; ctx.font = '11px monospace'; ctx.fillText('NETWORK OPERATIONS // LAB 01', 220, 270);
  const texture = new T.CanvasTexture(canvas);
  texture.colorSpace = T.SRGBColorSpace;
  return texture;
}

function screw(g: T.Group, x: number, y: number, z: number) {
  const m = cylinder(g, 0.025, 0.012, [x, y, z], metal());
  m.rotation.x = Math.PI / 2;
  box(g, [0.029, 0.005, 0.004], [x, y, z + 0.008], rubber(), 0.001);
}

export function hasWorkstationMonitor(kind: DeviceKind) {
  return kind === 'pc' || kind === 'laptop' || kind === 'attacker';
}

/** The mouth of each real socket, in interface order and in model coordinates. */
export function ethernetJackPosition(device: Device, index: number) {
  return hasWorkstationMonitor(device.kind)
    ? new T.Vector3(0.72, 0.46 + index * 0.24, 0.492)
    : new T.Vector3((index - (device.interfaces.length - 1) / 2) * 0.28, 0.48, 0.553);
}

function port(g: T.Group, { x, y, z }: T.Vector3, health: LinkHealth) {
  const rim = metal();
  box(g, [0.229, 0.188, 0.034], [x, y, z - 0.046], rubber(), 0.004);
  for (const offset of [-0.078, 0.078]) {
    box(g, [0.224, 0.024, 0.042], [x, y + offset, z - 0.013], rim, 0.004);
  }
  for (const offset of [-0.1, 0.1]) {
    box(g, [0.024, 0.138, 0.042], [x + offset, y, z - 0.013], rim, 0.004);
  }
  box(g, [0.177, 0.141, 0.021], [x, y, z - 0.029], rubber(), 0.004);
  const contact = new T.MeshStandardMaterial({ color: 0xb8a568, metalness: 0.8, roughness: 0.28 });
  for (let i = 0; i < 8; i++) {
    box(g, [0.009, 0.043, 0.009], [x - 0.059 + i * 0.017, y - 0.026, z - 0.014], contact, 0.001);
  }
  box(g, [0.063, 0.034, 0.017], [x - 0.062, y + 0.112, z - 0.016], rubber(), 0.004);
  const lens = new T.MeshStandardMaterial({
    color: health === 'up' ? 0x21724a : health === 'degraded' ? 0x885419 : 0x1b2425,
    emissive: health === 'up' ? 0x28e786 : health === 'degraded' ? 0xffa633 : 0,
    emissiveIntensity: 1.3,
    roughness: 0.28,
  });
  box(g, [0.037, 0.019, 0.013], [x - 0.062, y + 0.112, z - 0.006], lens, 0.003);
}

function monitor(g: T.Group, d: Device) {
  const shell = dark();
  box(g, [1.27, 0.79, 0.09], [-0.22, 1.11, 0.09], shell);
  const screen = new T.Mesh(new T.PlaneGeometry(1.16, 0.66), new T.MeshBasicMaterial({
    map: d.powered ? textTexture([
      `${d.label.toLowerCase()}@geekednet:~$`,
      `Interface ${d.interfaces[0]?.name ?? '—'}`,
      `IPv4 ${d.interfaces.find(i => i.ip)?.ip ?? 'not configured'}`,
      'Click the screen to open the console',
    ]) : null,
    color: d.powered ? 0xffffff : 0x070f17,
  }));
  screen.position.set(-0.22, 1.12, 0.141);
  screen.userData.monitorScreen = true;
  g.add(screen);
  box(g, [1.05, 0.008, 0.009], [-0.22, 0.744, 0.141], d.powered ? glow(0x208dc8) : rubber(), 0.002);
  box(g, [0.075, 0.47, 0.075], [-0.22, 0.54, 0.035], metal());
  box(g, [0.49, 0.045, 0.32], [-0.22, 0.3, 0.1], shell);
  box(g, [0.83, 0.045, 0.3], [-0.25, 0.31, 0.62], rubber());
  const keyMaterial = new T.MeshStandardMaterial({ color: 0x3f4b57, roughness: 0.64 });
  for (let row = 0; row < 4; row++) for (let col = 0; col < 13; col++) {
    box(g, [0.047, 0.014, 0.041], [-0.61 + col * 0.059, 0.343, 0.51 + row * 0.067], keyMaterial, 0.004);
  }
  const mouse = new T.Mesh(new T.SphereGeometry(0.1, 12, 8), shell);
  mouse.scale.set(0.7, 0.35, 1.1); mouse.position.set(0.35, 0.33, 0.62); g.add(mouse);
}

/** Real geometry, shared by the live lab and inventory product thumbnails. */
export function makeHardware(d: Device, portHealth: readonly LinkHealth[] = []): T.Group {
  const g = new T.Group();
  const shell = dark(); const alloy = metal(); const black = rubber();
  const pc = hasWorkstationMonitor(d.kind);
  if (pc) {
    // A compact workstation on anti-vibration feet, with vents and glass side panel.
    monitor(g, d);
    const towerHeight = Math.max(1.08, 0.34 + d.interfaces.length * 0.24);
    box(g, [0.43, towerHeight, 0.82], [0.72, 0.27 + towerHeight / 2, -0.01], shell, 0.045);
    box(g, [0.39, towerHeight - 0.07, 0.035], [0.72, 0.28 + towerHeight / 2, 0.42], alloy);
    const ventStart = 0.63 + Math.max(0, d.interfaces.length - 1) * 0.24;
    for (let y = ventStart; y < 0.27 + towerHeight - 0.12; y += 0.044) {
      box(g, [0.23, 0.017, 0.013], [0.69, y, 0.443], black, 0.002);
    }
    box(g, [0.018, 0.49, 0.016], [0.88, 0.9, 0.447], d.powered ? glow(0x31cada) : black, 0.005);
    box(g, [0.012, 0.83, 0.68], [0.94, 0.84, -0.01], new T.MeshPhysicalMaterial({ color: 0x173447, metalness: 0.1, roughness: 0.14, transparent: true, opacity: 0.54, side: T.DoubleSide }));
    for (const y of [0.59, 1.04]) {
      const fan = new T.Mesh(new T.TorusGeometry(0.15, 0.014, 8, 32), d.powered ? glow(0x229e90) : black);
      fan.rotation.y = Math.PI / 2; fan.position.set(0.925, y, -0.02); g.add(fan);
    }
    for (const x of [0.55, 0.88]) for (const z of [-0.31, 0.31]) box(g, [0.08, 0.045, 0.08], [x, 0.255, z], black);
  } else {
    const isRouter = ['router', 'ap', 'cloud'].includes(d.kind);
    const isServer = d.kind === 'server';
    const w = Math.max(isServer ? 1.28 : 1.85, d.interfaces.length * 0.28 + 0.18);
    const h = isServer ? 1.32 : 0.4;
    box(g, [w, h, 0.97], [0, 0.28 + h / 2, 0], shell, 0.045);
    box(g, [w - 0.05, 0.32, 0.025], [0, 0.5, 0.501], alloy);
    for (let row = 0; row < 4; row++) for (let col = 0; col < 9; col++) {
      box(g, [0.1, 0.006, 0.026], [-0.62 + col * 0.145, 0.285 + h, -0.26 + row * 0.085], black, 0.003);
    }
    for (const x of [-w / 2 + 0.09, w / 2 - 0.09]) { screw(g, x, 0.61, 0.527); screw(g, x, 0.39, 0.527); }
    for (const x of [-0.65, 0.65]) for (const z of [-0.33, 0.33]) cylinder(g, 0.075, 0.08, [x, 0.25, z], black);
    if (isRouter) for (const x of [-0.76, 0.76]) {
      const antenna = cylinder(g, 0.037, 1.02, [x, 1.02, -0.35], black);
      antenna.rotation.z = x * -0.15;
    }
    const label = new T.Mesh(new T.PlaneGeometry(0.8, 0.29), new T.MeshBasicMaterial({ map: textTexture(['NETWORK SYSTEMS'], `GEEKEDNET // ${d.kind.toUpperCase()}`) }));
    label.rotation.x = -Math.PI / 2; label.position.set(0, 0.291 + h, 0.19); g.add(label);
  }
  d.interfaces.forEach((_, index) => port(g, ethernetJackPosition(d, index), portHealth[index] ?? 'down'));
  const platform = box(g, [pc ? 2 : 2.15, 0.055, 1.48], [pc ? 0.12 : 0, 0.215, 0.09], new T.MeshStandardMaterial({ color: 0x131e2b, metalness: 0.5, roughness: 0.6 }), 0.06);
  platform.name = 'platform';
  const trim = d.powered ? glow(0x1679ac) : black;
  box(g, [pc ? 1.86 : 2.01, 0.012, 0.012], [pc ? 0.12 : 0, 0.214, 0.829], trim, 0.003);
  box(g, [0.012, 0.012, 1.25], [pc ? -0.866 : -1.06, 0.214, 0.09], trim, 0.003);
  const outline = new T.LineSegments(new T.EdgesGeometry(platform.geometry, 25), new T.LineBasicMaterial({ color: 0x23708c, transparent: true, opacity: 0.65 }));
  outline.userData.ignorePick = true;
  outline.position.copy(platform.position); outline.name = 'selection'; g.add(outline);
  const shadowCanvas = document.createElement('canvas'); shadowCanvas.width = shadowCanvas.height = 128;
  const shadowContext = shadowCanvas.getContext('2d')!;
  const shadowGradient = shadowContext.createRadialGradient(64, 64, 10, 64, 64, 62);
  shadowGradient.addColorStop(0, '#000000bb'); shadowGradient.addColorStop(0.6, '#00000066'); shadowGradient.addColorStop(1, '#00000000');
  shadowContext.fillStyle = shadowGradient; shadowContext.fillRect(0, 0, 128, 128);
  const shadow = new T.Mesh(new T.PlaneGeometry(2.8, 2.2), new T.MeshBasicMaterial({ map: new T.CanvasTexture(shadowCanvas), transparent: true, depthWrite: false }));
  shadow.userData.ignorePick = true;
  shadow.rotation.x = -Math.PI / 2; shadow.position.set(0, 0.183, 0.09); g.add(shadow);
  g.userData.deviceId = d.id;
  return g;
}

export function disposeObject(root: T.Object3D) {
  const textures = new Set<T.Texture>(); const materials = new Set<T.Material>(); const geometries = new Set<T.BufferGeometry>();
  root.traverse(obj => {
    const mesh = obj as T.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (mesh.material) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof T.Texture) textures.add(value);
    }
  });
  textures.forEach(t => t.dispose()); materials.forEach(m => m.dispose()); geometries.forEach(g => g.dispose());
}

const thumbnails = new Map<DeviceKind, string>();
export function hardwareThumbnail(kind: DeviceKind): string {
  if (thumbnails.has(kind)) return thumbnails.get(kind)!;
  const renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(216, 144); renderer.setPixelRatio(1); renderer.outputColorSpace = T.SRGBColorSpace;
  const scene = new T.Scene();
  const pmrem = new T.PMREMGenerator(renderer); const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04); scene.environment = environment.texture; scene.environmentIntensity = 1.2;
  room.dispose(); pmrem.dispose();
  scene.add(new T.HemisphereLight(0xd5edff, 0x2c3454, 3));
  const light = new T.DirectionalLight(0xffffff, 4); light.position.set(2, 4, 5); scene.add(light);
  const camera = new T.PerspectiveCamera(34, 1.5, 0.1, 30); camera.position.set(2.6, 2.8, 4.6); camera.lookAt(0, 0.7, 0);
  const portCount = kind === 'switch' ? 6 : hasWorkstationMonitor(kind) ? 1 : 4;
  const interfaces = Array.from({ length: portCount }, (_, i) => ({ id: String(i), name: String(i + 1) }));
  scene.add(makeHardware({ id: 'preview', kind, label: 'PC', powered: true, x: 0, y: 0, interfaces }));
  renderer.render(scene, camera);
  const data = renderer.domElement.toDataURL('image/png'); thumbnails.set(kind, data);
  disposeObject(scene); environment.dispose(); renderer.dispose(); renderer.forceContextLoss();
  return data;
}
