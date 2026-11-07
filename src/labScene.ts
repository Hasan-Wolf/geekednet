import * as T from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { deviceLinkStatus, interfaceLinkStatus, type Device, type Link, type NetworkState } from '../engine/index.js';
import { packetCableRoutes } from './cableRoute.js';
import { disposeObject, ethernetJackPosition, makeHardware, textTexture } from './labModels.js';
import { useStore } from './store.js';
import { LabCameraDirector, devicePosition } from './labCamera.js';
import { createOperationsDisplay } from './labActivity.js';
import { benchCoordinates, BenchClick } from './labLayout.js';
import { PACKET_BURST_MS, PACKET_DIAMETER_PX, PACKET_PULSE_COUNT, packetPulses } from './labPackets.js';

export interface LabScene {
  resetView: () => void;
  setView: (view: 'orbit' | 'top') => void;
  setBright: (bright: boolean) => void;
  setQuiet: (quiet: boolean) => void;
  zoom: (direction: 'in' | 'out') => void;
  focusDevice: (id: string) => void;
  drop: (kind: Device['kind'], x: number, y: number) => void;
  dispose: () => void;
}

const world = devicePosition;
const material = (color: number, metalness = 0.4, roughness = 0.65) => new T.MeshStandardMaterial({ color, metalness, roughness });
const emission = (color: number, strength = 2) => new T.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: strength });

function cube(root: T.Object3D, dimensions: number[], position: number[], mat: T.Material) {
  const mesh = new T.Mesh(new T.BoxGeometry(dimensions[0], dimensions[1], dimensions[2]), mat);
  mesh.position.set(position[0], position[1], position[2]);
  mesh.castShadow = true; mesh.receiveShadow = true; root.add(mesh); return mesh;
}

function benchTexture() {
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 1024;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#1e292f'; ctx.fillRect(0, 0, 1024, 1024);
  // Seeded grain keeps the surface stable between mounts, without external assets.
  let seed = 712;
  for (let i = 0; i < 60000; i++) {
    seed = (seed * 16807) % 2147483647; const x = seed % 1024;
    seed = (seed * 16807) % 2147483647; const y = seed % 1024;
    ctx.fillStyle = i % 2 ? '#ffffff08' : '#00000016'; ctx.fillRect(x, y, 1.4, 1);
  }
  for (let i = 0; i <= 1024; i += 32) {
    ctx.strokeStyle = i % 128 === 0 ? '#8ca4af48' : '#718a9927'; ctx.lineWidth = i % 128 === 0 ? 1.3 : 0.8;
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 1024); ctx.moveTo(0, i); ctx.lineTo(1024, i); ctx.stroke();
  }
  const texture = new T.CanvasTexture(canvas); texture.colorSpace = T.SRGBColorSpace;
  texture.wrapS = texture.wrapT = T.RepeatWrapping; texture.repeat.set(2, 1.5); texture.anisotropy = 4;
  return texture;
}

function makeRoom(scene: T.Scene) {
  const wallBackdrop = new T.Group(); scene.add(wallBackdrop);
  const activity: Array<{ light: T.MeshStandardMaterial; period: number; phase: number }> = [];
  const slate = material(0x202a36, 0.45); const wall = material(0x111b29, 0.25, 0.8);
  cube(scene, [36, 0.2, 32], [0, -2.7, 0], material(0x1a202b, 0.15));
  const floorGrid = new T.GridHelper(36, 36, 0x3e4a59, 0x283544); floorGrid.position.y = -2.59; scene.add(floorGrid);
  cube(wallBackdrop, [36, 12, 0.3], [0, 3, -9], wall);
  for (let x = -17; x < 18; x += 2) cube(wallBackdrop, [0.018, 9, 0.03], [x, 2, -8.82], material(0x354456));
  // Recessed laboratory racks, recognizable behind the work surface.
  for (const x of [-8.8, -5.9, 5.9, 8.8]) {
    cube(scene, [2.25, 5.4, 1.3], [x, 0.1, -6.5], material(0x0b111b, 0.7));
    for (const edge of [-1, 1]) cube(scene, [0.07, 5.3, 0.11], [x + edge, 0.1, -5.81], slate);
    for (let row = 0; row < 11; row++) {
      const y = -2.2 + row * 0.44;
      cube(scene, [1.93, 0.35, 0.06], [x, y, -5.79], material(row % 2 ? 0x2c3641 : 0x1a2532, 0.6));
      for (let vent = 0; vent < 5; vent++) cube(scene, [0.2, 0.018, 0.02], [x - 0.42, y - 0.1 + vent * 0.045, -5.75], material(0x060b13));
      for (let led = 0; led < 3; led++) {
        const lamp = emission(led === 2 ? 0x2588cd : 0x2cda7e, led === 0 ? 1.2 : 0.65);
        cube(scene, [0.038, 0.035, 0.025], [x + 0.55 + led * 0.1, y, -5.74], lamp);
        if (led === 1 || (led === 2 && row % 3 === 0)) activity.push({ light: lamp, period: 1600 + row * 83 + led * 140, phase: (row * 311 + x * 130 + 5000) % 2000 });
      }
    }
  }
  // Wall console and architectural light strips.
  cube(wallBackdrop, [6.4, 2.8, 0.18], [0, 2.1, -8.6], material(0x080e17));
  const operations = createOperationsDisplay();
  const displayMaterial = new T.MeshBasicMaterial({ map: operations.texture, color: 0xb0c9d7 });
  const consoleScreen = new T.Mesh(new T.PlaneGeometry(6.1, 2.55), displayMaterial);
  consoleScreen.position.set(0, 2.1, -8.49); wallBackdrop.add(consoleScreen);
  for (const x of [-11, 11]) cube(wallBackdrop, [0.07, 7, 0.06], [x, 1, -8.65], emission(x < 0 ? 0x216ba5 : 0x188c74, 1.8));
  for (const x of [-5, 5]) {
    cube(scene, [3, 0.12, 0.7], [x, 6.4, -2], material(0x1a2432));
    cube(scene, [2.8, 0.025, 0.56], [x, 6.33, -2], emission(0xb8d7ec, 2.5));
  }
  // Heavy metal bench, slightly chamfered by its layered edge, with a gridded ESD mat.
  cube(scene, [18, 0.36, 14.3], [0, -0.04, 2], material(0x101820, 0.75, 0.32));
  cube(scene, [17.8, 0.04, 14.1], [0, 0.16, 2], new T.MeshStandardMaterial({ color: 0x99a9b0, map: benchTexture(), metalness: 0.28, roughness: 0.78 }));
  cube(scene, [17.6, 0.035, 0.027], [0, -0.04, 9.16], emission(0x196d82, 1.6));
  for (const x of [-7.6, 7.6]) for (const z of [-3.7, 7.8]) cube(scene, [0.32, 2.4, 0.32], [x, -1.43, z], slate);
  for (const x of [-8.6, 8.6]) for (const z of [-4.5, 8.5]) {
    const screw = new T.Mesh(new T.CylinderGeometry(0.055, 0.055, 0.015, 12), material(0x8294a2, 0.8, 0.3));
    screw.position.set(x, 0.188, z); scene.add(screw);
  }
  // Printed ESD/caution markings and ruler ticks are part of the workbench.
  for (let i = -8; i <= 8; i += 0.25) cube(scene, [0.012, 0.003, Number.isInteger(i) ? 0.2 : 0.08], [i, 0.184, 8.8], material(0x90a1a7, 0.1));
  const marking = new T.Mesh(new T.PlaneGeometry(2.7, 0.8), new T.MeshBasicMaterial({ map: textTexture(['ELECTROSTATIC PROTECTED AREA'], 'GEEKEDNET // BENCH 01'), transparent: true, opacity: 0.66 }));
  marking.rotation.x = -Math.PI / 2; marking.position.set(-5.8, 0.186, 3.5); scene.add(marking);
  // A small oscilloscope and test leads at the back of the bench.
  const scope = new T.Group();
  cube(scope, [1.7, 0.95, 0.75], [0, 0.67, 0], material(0x6b747b, 0.3));
  cube(scope, [1.05, 0.64, 0.03], [-0.2, 0.7, 0.39], material(0x071b23));
  const wave: T.Vector3[] = [];
  for (let i = 0; i <= 60; i++) wave.push(new T.Vector3(-0.68 + i / 64, 0.7 + Math.sin(i * 0.25) * 0.17, 0.413));
  scope.add(new T.Line(new T.BufferGeometry().setFromPoints(wave), new T.LineBasicMaterial({ color: 0x48c9c1 })));
  for (let i = 0; i < 3; i++) { const knob = new T.Mesh(new T.CylinderGeometry(0.09, 0.09, 0.07, 16), material(0xc0c7ca)); knob.rotation.x = Math.PI / 2; knob.position.set(0.61, 0.46 + i * 0.22, 0.42); scope.add(knob); }
  scope.position.set(-5.9, 0, -2.7); scope.rotation.y = 0.22; scene.add(scope);
  cube(scene, [2.4, 0.12, 0.42], [5.9, 0.27, -3.15], material(0x77838c));
  for (let i = 0; i < 5; i++) cube(scene, [0.25, 0.025, 0.18], [5.15 + i * 0.37, 0.343, -3.15], material(0x101c29));
  return {
    update(elapsed: number, network: NetworkState, quiet: boolean, eye: T.Vector3) {
      // A cutaway keeps the workbench visible while orbiting behind the room.
      wallBackdrop.visible = eye.z > -8.4;
      operations.update(elapsed, network, quiet);
      displayMaterial.color.setHex(quiet ? 0x59717f : 0xb0c9d7);
      for (const lamp of activity) {
        const phase = (elapsed + lamp.phase) % lamp.period;
        lamp.light.emissiveIntensity = quiet ? 0.65 : phase < 130 || (phase > 340 && phase < 430) ? 2.1 : 0.15;
      }
    },
  };
}

function plugPoint(device: Device, interfaceId: string) {
  const index = device.interfaces.findIndex(iface => iface.id === interfaceId);
  if (index < 0) return null;
  const socket = ethernetJackPosition(device, index);
  socket.z += 0.073; // cable exits the strain relief, outside the socket
  return socket.add(world(device));
}

export function cableCurve(a: Device, b: Device, link: Link) {
  const from = plugPoint(a, link.a.ifaceId);
  const to = plugPoint(b, link.b.ifaceId);
  if (!from || !to) return null;
  return new T.CatmullRomCurve3([
    from,
    from.clone().add(new T.Vector3(0, -0.045, 0.26)),
    new T.Vector3((from.x + to.x) / 2, 0.235, Math.max(from.z, to.z) + 0.85),
    to.clone().add(new T.Vector3(0, -0.045, 0.26)),
    to,
  ]);
}

export function createLabScene(
  host: HTMLElement,
  labels: HTMLElement,
  { onError, onOpenConsole, readOnly = false }: {
    onError: () => void;
    onOpenConsole?: (deviceId: string) => void;
    readOnly?: boolean;
  },
): LabScene {
  const renderer = new T.WebGLRenderer({ antialias: true, powerPreference: readOnly ? 'low-power' : 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, readOnly ? 1.25 : 1.65));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = T.PCFSoftShadowMap;
  renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.23;
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.domElement.setAttribute('aria-label', readOnly
    ? '3D network bench. Tap a device to see its settings.'
    : 'Interactive 3D networking workbench. Click a PC screen to open its console. Drag empty space to rotate, or click it to zoom out.');
  renderer.domElement.setAttribute('role', 'img');
  host.appendChild(renderer.domElement);
  const scene = new T.Scene(); scene.background = new T.Color(0x0c1421); scene.fog = new T.Fog(0x0c1421, 38, 90);
  const camera = new T.PerspectiveCamera(39, 1, 0.1, 90);
  const controls = new OrbitControls(camera, renderer.domElement);
  if (readOnly) renderer.domElement.style.touchAction = 'pan-y';
  controls.enableDamping = true; controls.dampingFactor = 0.08; controls.minDistance = 2.5; controls.maxDistance = 70;
  controls.rotateSpeed = 0.65; controls.zoomSpeed = 0.85; controls.panSpeed = 0.75;
  controls.maxPolarAngle = Math.PI / 2.7; controls.minPolarAngle = 0.08; controls.enablePan = true;
  controls.mouseButtons = { LEFT: T.MOUSE.ROTATE, MIDDLE: T.MOUSE.DOLLY, RIGHT: T.MOUSE.PAN };
  const pmrem = new T.PMREMGenerator(renderer); const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04); scene.environment = environment.texture; scene.environmentIntensity = 0.45;
  room.dispose(); pmrem.dispose();
  scene.add(new T.HemisphereLight(0xc7e1f5, 0x293146, 1.15));
  const key = new T.DirectionalLight(0xd7e8f7, 4.4); key.position.set(-4, 9, 5); key.castShadow = true;
  key.shadow.mapSize.setScalar(readOnly ? 1024 : 2048); key.shadow.camera.left = -12; key.shadow.camera.right = 12; key.shadow.camera.top = 10; key.shadow.camera.bottom = -9; key.shadow.bias = -0.0004; key.shadow.normalBias = 0.025; scene.add(key);
  const rim = new T.PointLight(0x1d92b7, 65, 22); rim.position.set(-6, 3, -2); scene.add(rim);
  const greenRim = new T.PointLight(0x258a69, 55, 24); greenRim.position.set(6, 4, -4); scene.add(greenRim);
  const background = makeRoom(scene);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let quiet = reducedMotion;
  const director = new LabCameraDirector(camera, controls, reducedMotion);
  const composer = readOnly ? null : new EffectComposer(renderer, new T.WebGLRenderTarget(1, 1, {
    type: T.HalfFloatType, samples: Math.min(4, renderer.capabilities.maxSamples),
  }));
  if (composer) {
    composer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    const bloom = new UnrealBloomPass(new T.Vector2(1, 1), 0.32, 0.42, 1.1);
    composer.addPass(new RenderPass(scene, camera)); composer.addPass(bloom); composer.addPass(new OutputPass());
  }
  const deviceRoot = new T.Group(); const cables = new T.Group(); const packetRoot = new T.Group();
  scene.add(deviceRoot, cables, packetRoot);
  const deviceMap = new Map<string, { group: T.Group; signature: string; label: HTMLButtonElement }>();
  const liveCablePaths = new Map<string, { curve: T.CatmullRomCurve3; length: number }>();
  let disposed = false; let packetId = -1; let packetStart = 0; let packetFinished = false;
  let needsRender = true;
  const home = (animate = !readOnly) => {
    director.reset(useStore.getState().network.devices, animate);
    if (readOnly) controls.enabled = false;
    needsRender = true;
  };
  const focus = (id: string) => director.focus(id, useStore.getState().network.devices);
  const select = (id: string) => {
    const state = useStore.getState();
    if (readOnly) {
      state.selectDevice(state.selectedDeviceId === id ? null : id);
      return;
    }
    if (state.connectMode) { state.clickDeviceForConnect(id); return; }
    if (state.selectedDeviceId === id) focus(id);
    else state.selectDevice(id);
  };
  function updateNetwork(net: NetworkState) {
    needsRender = true;
    const current = useStore.getState();
    for (const [id, item] of deviceMap) if (!net.devices.some(d => d.id === id)) {
      deviceRoot.remove(item.group); disposeObject(item.group); item.label.remove(); deviceMap.delete(id);
    }
    for (const d of net.devices) {
      const portHealth = d.interfaces.map(iface => interfaceLinkStatus(net, d.id, iface.id).health);
      const signature = JSON.stringify([d.kind, d.label, d.powered, d.interfaces.length,
        d.interfaces[0]?.name, d.interfaces.find(iface => iface.ip)?.ip, portHealth]);
      let item = deviceMap.get(d.id);
      if (!item || item.signature !== signature) {
        if (item) { deviceRoot.remove(item.group); disposeObject(item.group); }
        const group = makeHardware(d, portHealth); deviceRoot.add(group);
        const label = item?.label ?? document.createElement('button'); label.className = 'lab-device-label';
        label.dataset.kind = d.kind;
        label.setAttribute('aria-label', `Select ${d.label}`); label.dataset.deviceId = d.id;
        label.title = `${d.label} — click to configure`;
        if (readOnly) label.tabIndex = -1; // The phone provides a separate row of accessible device buttons.
        label.onclick = e => { e.stopPropagation(); select(d.id); };
        if (!item) labels.appendChild(label);
        item = { group, signature, label }; deviceMap.set(d.id, item);
      }
      item.group.position.copy(world(d));
      const status = deviceLinkStatus(net, d.id);
      item.label.textContent = '';
      const name = document.createElement('strong'); name.textContent = d.label;
      const ip = document.createElement('span'); ip.textContent = d.interfaces.find(i => i.ip)?.ip ?? (['switch', 'hub'].includes(d.kind) ? `L2 · ${d.interfaces.length} ports` : d.kind === 'router' ? `L3 · ${d.interfaces.length} ports` : 'IP not set');
      const dot = document.createElement('i'); dot.className = `lab-led ${status.health}`; dot.title = status.reason;
      item.label.append(dot, name, ip);
      item.label.classList.toggle('selected', current.selectedDeviceId === d.id);
      item.label.classList.toggle('source', current.connectSourceId === d.id);
      const outline = item.group.getObjectByName('selection') as T.LineSegments;
      (outline.material as T.LineBasicMaterial).color.set(current.selectedDeviceId === d.id || current.connectSourceId === d.id ? 0x4df3ba : 0x2c7dae);
      (outline.material as T.LineBasicMaterial).opacity = current.selectedDeviceId === d.id ? 1 : 0.5;
    }
    disposeObject(cables); cables.clear(); liveCablePaths.clear();
    for (const link of net.links) {
      const a = net.devices.find(d => d.id === link.a.deviceId); const b = net.devices.find(d => d.id === link.b.deviceId);
      if (!a || !b) continue;
      const curve = cableCurve(a, b, link);
      if (!curve) continue;
      const health = interfaceLinkStatus(net, a.id, link.a.ifaceId).health;
      const sheathColor = health === 'up' ? 0x229ac9 : health === 'degraded' ? 0xa47b3d : 0x566374;
      const sheath = new T.Mesh(new T.TubeGeometry(curve, 56, 0.006, 7, false), material(sheathColor, 0.15, 0.4));
      sheath.castShadow = true; sheath.receiveShadow = true; sheath.userData.linkId = link.id; cables.add(sheath);
      const hitArea = new T.Mesh(new T.TubeGeometry(curve, 32, 0.075, 5, false), new T.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }));
      hitArea.userData.linkId = link.id; cables.add(hitArea);
      if (health === 'up') {
        liveCablePaths.set(link.id, { curve, length: curve.getLength() });
        const points = curve.getPoints(72).flatMap(p => [p.x, p.y, p.z]);
        const core = new Line2(new LineGeometry().setPositions(points), new LineMaterial({ color: 0x58c9f2, linewidth: 1.5, worldUnits: false, alphaToCoverage: true }));
        core.userData.ignorePick = true; cables.add(core);
      }
      for (const point of [curve.getPoint(0), curve.getPoint(1)]) {
        const connector = cube(cables, [0.146, 0.109, 0.073], [point.x, point.y, point.z - 0.069], material(0x88aeb9, 0.28, 0.24));
        const boot = cube(cables, [0.102, 0.078, 0.052], [point.x, point.y, point.z - 0.023], material(sheathColor, 0.15, 0.72));
        connector.userData.linkId = link.id;
        boot.userData.linkId = link.id;
      }
    }
  }
  updateNetwork(useStore.getState().network);
  const unsubscribe = useStore.subscribe((state, previous) => {
    if (state.network !== previous.network || state.selectedDeviceId !== previous.selectedDeviceId || state.connectSourceId !== previous.connectSourceId) updateNetwork(state.network);
    if (state.activeLabId !== previous.activeLabId || state.topologyId !== previous.topologyId || state.phoneLabId !== previous.phoneLabId) home();
    else if (!readOnly && state.selectedDeviceId !== previous.selectedDeviceId) {
      if (state.selectedDeviceId && !state.connectMode) focus(state.selectedDeviceId);
      else if (!state.selectedDeviceId) home();
    }
  });
  const ray = new T.Raycaster(); const pointer = new T.Vector2(); const plane = new T.Plane(new T.Vector3(0, 1, 0), -0.2);
  function setRay(x: number, y: number) {
    const rect = renderer.domElement.getBoundingClientRect(); pointer.set((x - rect.left) / rect.width * 2 - 1, -(y - rect.top) / rect.height * 2 + 1); ray.setFromCamera(pointer, camera);
  }
  function floorPoint(x: number, y: number) { setRay(x, y); return ray.ray.intersectPlane(plane, new T.Vector3()); }
  function pick(x: number, y: number) {
    setRay(x, y);
    const hit = ray.intersectObjects([...deviceRoot.children, ...cables.children], true).find(hit => !hit.object.userData.ignorePick);
    let object: T.Object3D | null = hit?.object ?? null;
    while (object && !object.userData.deviceId && !object.userData.linkId) object = object.parent;
    if (!object) return undefined;
    return {
      deviceId: object.userData.deviceId as string | undefined,
      linkId: object.userData.linkId as string | undefined,
      screen: hit?.object.userData.monitorScreen === true,
    };
  }
  let drag: { id?: string; linkId?: string; screen: boolean; x: number; y: number; offset: T.Vector3; moved: boolean; pointerId: number } | null = null;
  const benchClick = new BenchClick();
  let emptyClick = false;
  const down = (e: PointerEvent) => {
    emptyClick = false; benchClick.cancel();
    if (e.button !== 0) return;
    if (readOnly) { benchClick.begin(e.clientX, e.clientY, e.pointerId); return; }
    const hit = pick(e.clientX, e.clientY);
    if (!hit) { benchClick.begin(e.clientX, e.clientY, e.pointerId); director.cancel(); return; }
    const d = useStore.getState().network.devices.find(d => d.id === hit.deviceId);
    const point = floorPoint(e.clientX, e.clientY);
    drag = { id: hit.deviceId, linkId: hit.linkId, screen: hit.screen, x: e.clientX, y: e.clientY, offset: d && point ? point.sub(world(d)) : new T.Vector3(), moved: false, pointerId: e.pointerId };
    director.cancel();
    controls.enabled = false; e.stopImmediatePropagation(); renderer.domElement.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    benchClick.move(e.clientX, e.clientY);
    if (readOnly) return;
    if (!drag) {
      const hit = pick(e.clientX, e.clientY);
      renderer.domElement.style.cursor = hit?.screen || hit?.linkId ? 'pointer' : 'grab';
      return;
    }
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 5) drag.moved = true;
    if (!drag.moved || !drag.id || useStore.getState().connectMode) return;
    const point = floorPoint(e.clientX, e.clientY); if (!point) return;
    point.sub(drag.offset);
    const coordinates = benchCoordinates(point);
    useStore.getState().moveDevice(drag.id, coordinates.x, coordinates.y);
    renderer.domElement.style.cursor = 'grabbing';
  };
  const up = (e: PointerEvent) => {
    if (readOnly) {
      benchClick.move(e.clientX, e.clientY);
      if (benchClick.finish(e.pointerId)) {
        const id = pick(e.clientX, e.clientY)?.deviceId;
        if (id) select(id);
      }
      return;
    }
    if (!drag) { benchClick.move(e.clientX, e.clientY); emptyClick = benchClick.finish(e.pointerId); return; }
    const state = useStore.getState();
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) <= 5) {
      if (drag.id) {
        select(drag.id);
        if (drag.screen && !state.connectMode) onOpenConsole?.(drag.id);
      }
      else if (drag.linkId) state.removeLink(drag.linkId);
    }
    if (renderer.domElement.hasPointerCapture(drag.pointerId)) renderer.domElement.releasePointerCapture(drag.pointerId);
    drag = null; controls.enabled = !director.moving; e.stopImmediatePropagation();
  };
  const click = () => {
    if (!emptyClick) return;
    emptyClick = false;
    const state = useStore.getState();
    if (state.selectedDeviceId) state.selectDevice(null); else home();
  };
  const cancel = () => { drag = null; benchClick.cancel(); emptyClick = false; controls.enabled = !readOnly; };
  const lostContext = (e: Event) => { e.preventDefault(); onError(); };
  renderer.domElement.addEventListener('pointerdown', down, true); renderer.domElement.addEventListener('pointermove', move);
  renderer.domElement.addEventListener('pointerup', up, true); renderer.domElement.addEventListener('pointercancel', cancel); renderer.domElement.addEventListener('webglcontextlost', lostContext);
  renderer.domElement.addEventListener('click', click);
  const observer = new ResizeObserver(() => {
    const width = host.clientWidth; const height = host.clientHeight; if (!width || !height) return;
    const previousAspect = camera.aspect;
    camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height); composer?.setSize(width, height);
    needsRender = true;
    if (readOnly) home();
    else if (Math.abs(camera.aspect - previousAspect) > 0.15) director.reframe(useStore.getState().network.devices);
  }); observer.observe(host);
  camera.aspect = (host.clientWidth || 800) / (host.clientHeight || 700); home(false);
  if (!readOnly && useStore.getState().selectedDeviceId) focus(useStore.getState().selectedDeviceId!);
  const packetColors = [0x47f29c, 0x42bfff];
  const packetMaterials = packetColors.map(color => new T.MeshBasicMaterial({ color: new T.Color(color).multiplyScalar(1.2) }));
  const pulseGeometry = new T.SphereGeometry(0.024, 12, 10);
  const particleGeometry = new T.SphereGeometry(1, 10, 8);
  const tailMaterials = packetColors.map(color => [0.5, 0.3, 0.16, 0.07].map(opacity => new T.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false })));
  const packetVisuals: T.Group[] = [];
  const startTime = performance.now();
  let idleStart = startTime;
  let frame = 0;
  let lastFrame = -Infinity;
  function animate(now: number) {
    if (disposed) return;
    frame = requestAnimationFrame(animate);
    const state = useStore.getState();
    if (readOnly && (now - lastFrame < 30 || (!needsRender && !state.packet && !state.ambientPath))) return;
    lastFrame = now;
    needsRender = false;
    director.tick(now); controls.update();
    background.update(now - startTime, state.network, readOnly || quiet || reducedMotion, camera.position);
    const packet = state.packet;
    if (packet && packet.id !== packetId) {
      packetId = packet.id; packetStart = now; packetFinished = false;
    }
    packetVisuals.forEach(group => { group.visible = false; });
    const paths = packet ? packetCableRoutes(state.network, packet.path, packet.recipients) : state.ambientPath ? packetCableRoutes(state.network, state.ambientPath) : [];
    const runs = paths.map(path => {
      const segments: { curve: T.CatmullRomCurve3; length: number; reverse: boolean }[] = [];
      let total = 0;
      for (let i = 1; i < path.length; i++) {
        const from = path[i - 1];
        const to = path[i];
        const link = state.network.links.find(l => liveCablePaths.has(l.id) &&
          ((l.a.deviceId === from && l.b.deviceId === to) || (l.a.deviceId === to && l.b.deviceId === from)));
        const geometry = link && liveCablePaths.get(link.id);
        if (!geometry || !link) return { segments: [], total: 0 };
        segments.push({ ...geometry, reverse: link.a.deviceId !== from });
        total += geometry.length;
      }
      return { segments, total };
    });
    const loop = !packet || (packetFinished && packet.success);
    const elapsed = loop ? now - idleStart : now - packetStart;
    const pulses = readOnly && reducedMotion ? [] : packetPulses(elapsed, Math.max(0, ...runs.map(run => run.total)), loop);
    runs.forEach(({ segments, total }, runIndex) => {
      if (total <= 0) return;
      for (const pulse of pulses) {
        if (pulse.distance > total) continue;
        const visualIndex = runIndex * PACKET_PULSE_COUNT + pulse.index;
        let visual = packetVisuals[visualIndex];
        if (!visual) {
          visual = new T.Group(); visual.add(new T.Mesh(pulseGeometry, packetMaterials[pulse.color]));
          tailMaterials[pulse.color].forEach(mat => visual.add(new T.Mesh(particleGeometry, mat)));
          packetVisuals[visualIndex] = visual; packetRoot.add(visual);
        }
        visual.visible = true;
        let pixelWorld = 0;
        visual.children.forEach((part, index) => {
          const tailOffset = index * pixelWorld * 3.5;
          let distance = Math.max(0, pulse.distance - tailOffset);
          part.visible = index === 0 || pulse.distance >= tailOffset;
          for (let c = 0; c < segments.length; c++) {
            const { curve, length, reverse } = segments[c];
            if (distance <= length || c === segments.length - 1) {
              const t = T.MathUtils.clamp(distance / length, 0, 1);
              part.position.copy(curve.getPointAt(reverse ? 1 - t : t));
              if (index === 0) pixelWorld = 2 * camera.position.distanceTo(part.position) * Math.tan(camera.fov * Math.PI / 360) / Math.max(1, host.clientHeight);
              const scale = T.MathUtils.clamp(pixelWorld * (readOnly ? 6.5 : PACKET_DIAMETER_PX) / 0.048, 0.25, 16);
              if (index === 0) part.scale.setScalar(scale);
              else part.scale.setScalar((0.019 - (index - 1) * 0.0035) * scale);
              break;
            }
            distance -= length;
          }
        });
      }
    });
    if (packet && !packetFinished && now - packetStart >= PACKET_BURST_MS + 50) { packetFinished = true; idleStart = now; state.packetArrived(packet.id); }
    for (const [id, item] of deviceMap) {
      const device = state.network.devices.find(d => d.id === id); if (!device) continue;
      const p = world(device).add(new T.Vector3(0, 0.24, 1.8)); p.project(camera);
      const labelY = (-p.y * 0.5 + 0.5) * host.clientHeight;
      const y = !readOnly && state.selectedDeviceId === id ? Math.min(host.clientHeight - 116, labelY) : labelY;
      item.label.style.transform = `translate(-50%, -50%) translate(${(p.x * 0.5 + 0.5) * host.clientWidth}px, ${y}px)`;
      item.label.style.visibility = p.z > 1 || p.z < -1 ? 'hidden' : 'visible';
    }
    if (composer) composer.render();
    else renderer.render(scene, camera);
  }
  frame = requestAnimationFrame(animate);
  return {
    resetView: () => home(),
    setView(view) { director.setView(view, useStore.getState().network.devices); },
    setBright(bright) { renderer.toneMappingExposure = bright ? 1.65 : 1.23; key.intensity = bright ? 5.8 : 4.4; },
    setQuiet(value) { quiet = value; },
    zoom(direction) { director.zoom(direction); },
    focusDevice: select,
    drop(kind, x, y) { const p = floorPoint(x, y); if (p) { const coordinates = benchCoordinates(p); useStore.getState().addDevice(kind, coordinates.x, coordinates.y); } },
    dispose() {
      disposed = true; cancelAnimationFrame(frame); unsubscribe(); observer.disconnect(); controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', down, true); renderer.domElement.removeEventListener('pointermove', move); renderer.domElement.removeEventListener('pointerup', up, true); renderer.domElement.removeEventListener('pointercancel', cancel); renderer.domElement.removeEventListener('webglcontextlost', lostContext);
      renderer.domElement.removeEventListener('click', click);
      labels.replaceChildren(); particleGeometry.dispose(); pulseGeometry.dispose(); packetMaterials.forEach(mat => mat.dispose()); tailMaterials.flat().forEach(mat => mat.dispose()); composer?.passes.forEach(pass => pass.dispose()); composer?.dispose(); disposeObject(scene); environment.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    },
  };
}
