/**
 * The network canvas (Build Brief §11): drag-drop devices, click-to-connect
 * cables with port labels, packet animation along the engine's returned `path`,
 * and the docked companion bot. Reads/writes the working network through the
 * store; all reachability comes from the engine.
 */
import { useEffect, useRef, useState } from 'react';
import { deviceLinkStatus, type Device, type NetworkState } from '../../engine/index.js';
import { blockedAt, cableRoute, packetCableRoutes } from '../cableRoute.js';
import { deviceIcon } from '../devices.js';
import type { TopologyDemo } from '../topologies/index.js';
import { useStore, type PacketAnim } from '../store.js';
import { CompanionBot } from './CompanionBot.js';
import { TopologyBrowser, TopologyControls } from './Topology.js';
import { WinBar } from './WinBar.js';

// Node and port-label metrics. Exported, with `center` and `portLabel` below, so
// a lab's or a topology's device placement can be checked against the real
// renderer instead of a copy of it — see src/__tests__/topologies.test.ts.
export const NODE_W = 92;
export const BOX_H = 60;
/** The name + IP lines printed under a node's box. Port labels clear these too,
 *  otherwise a cable leaving downwards drops its label onto the device name. */
export const NODE_TEXT_H = 34;

// Port-label pill metrics. The label font is monospaced at 9px, so the pill width
// is predictable from the character count — no text measuring needed.
const LABEL_CHAR_W = 5.4;
const LABEL_PAD_X = 7;
export const LABEL_H = 15;
const LABEL_GAP = 9;

// Right-click menu footprint, used to keep it clear of the canvas edges.
const MENU_W = 148;
const MENU_H = 40;

export function center(d: Device): { x: number; y: number } {
  return { x: d.x + NODE_W / 2, y: d.y + BOX_H / 2 };
}

/** Distance from a node's box center out to the edge of its footprint along a
 *  unit direction — the ray/rectangle hit, with extra room below for the text. */
function edgeDistance(ux: number, uy: number): number {
  const tx = Math.abs(ux) < 1e-6 ? Infinity : NODE_W / 2 / Math.abs(ux);
  const halfY = uy > 0 ? BOX_H / 2 + NODE_TEXT_H : BOX_H / 2;
  const ty = Math.abs(uy) < 1e-6 ? Infinity : halfY / Math.abs(uy);
  return Math.min(tx, ty);
}

export interface PortLabel {
  key: string;
  x: number;
  y: number;
  w: number;
  text: string;
}

/** Places one interface label just outside the source node's footprint, pushed
 *  along the cable toward its peer so it sits beside the box, not on top of it. */
export function portLabel(key: string, from: Device, to: Device, text: string): PortLabel {
  const a = center(from);
  const b = center(to);
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const w = text.length * LABEL_CHAR_W + LABEL_PAD_X * 2;
  // How far the pill itself reaches along the cable, so the gap clears the whole
  // pill rather than just the point it is centered on.
  const reach = (w / 2) * Math.abs(ux) + (LABEL_H / 2) * Math.abs(uy);
  // Cap at 42% of the run so both ends of a short cable stay apart.
  const d = Math.min(edgeDistance(ux, uy) + LABEL_GAP + reach, len * 0.42);
  return { key, x: a.x + ux * d, y: a.y + uy * d, w, text };
}

function deviceForIface(net: NetworkState, deviceId: string): Device | undefined {
  return net.devices.find((d) => d.id === deviceId);
}

export function Canvas() {
  const net = useStore((s) => s.network);
  const selectedId = useStore((s) => s.selectedDeviceId);
  const connectMode = useStore((s) => s.connectMode);
  const connectSourceId = useStore((s) => s.connectSourceId);
  const packet = useStore((s) => s.packet);
  const lastResult = useStore((s) => s.lastResult);

  const addDevice = useStore((s) => s.addDevice);
  const moveDevice = useStore((s) => s.moveDevice);
  const selectDevice = useStore((s) => s.selectDevice);
  const toggleConnect = useStore((s) => s.toggleConnectMode);
  const clickConnect = useStore((s) => s.clickDeviceForConnect);
  const removeLink = useStore((s) => s.removeLink);
  const removeDevice = useStore((s) => s.removeDevice);
  const undoDelete = useStore((s) => s.undoDelete);
  const dismissUndo = useStore((s) => s.dismissUndo);
  const lastDeleted = useStore((s) => s.lastDeleted);
  const dismissResult = useStore((s) => s.dismissResult);
  const packetArrived = useStore((s) => s.packetArrived);
  const ambientPath = useStore((s) => s.ambientPath);
  // The win bar sits at the bottom of this column; the pieces that also live
  // down there (result banner, companion bot) step up over it while it is open.
  const winOpen = useStore((s) => !!s.justCompleted);
  // Learn Topology shares this canvas. With no shape loaded it takes it over
  // for the bar list; with one loaded the canvas is an ordinary editable canvas
  // again, plus the controls that get the student back out of it.
  const demo = useStore((s) => s.topologies.find((t) => t.id === s.topologyId) ?? null);
  const browsing = useStore((s) => s.topologyMode && s.topologyId === null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const [dropActive, setDropActive] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ deviceId: string; x: number; y: number } | null>(null);

  // ---- canvas-level deletion ----
  //
  // The config panel's trash icon is the only way to remove a device today, and
  // it is three clicks deep. These are the two gestures a student already knows
  // from every other canvas: select and press Delete, or right-click the thing.
  //
  // Deleting is destructive and one keystroke away, so it is always paired with
  // the undo offer the store keeps.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      // Never while the student is typing — Backspace belongs to the terminal
      // and every address field before it belongs to the canvas.
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
        return;
      }
      if (e.key === 'Escape') {
        setMenu(null);
        return;
      }
      if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
        if (!useStore.getState().lastDeleted) return;
        e.preventDefault();
        undoDelete();
        return;
      }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const id = useStore.getState().selectedDeviceId;
      if (!id) return;
      e.preventDefault(); // Backspace still navigates back in some browsers
      setMenu(null);
      removeDevice(id);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [removeDevice, undoDelete]);

  // Any click that is not on the menu itself closes it, including one that lands
  // on another device.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  function onNodeContextMenu(e: React.MouseEvent, d: Device) {
    e.preventDefault();
    e.stopPropagation();
    const rect = wrapRef.current!.getBoundingClientRect();
    selectDevice(d.id);
    // Placed in canvas coordinates and kept inside them: the canvas clips its
    // own overflow, so a menu opened near the edge would simply be cut off.
    setMenu({
      deviceId: d.id,
      x: Math.min(e.clientX - rect.left, Math.max(0, rect.width - MENU_W - 8)),
      y: Math.min(e.clientY - rect.top, Math.max(0, rect.height - MENU_H - 8)),
    });
  }

  // ---- pointer-drag of a placed device ----
  const dragRef = useRef<{ id: string; offX: number; offY: number } | null>(null);

  function onNodePointerDown(e: React.PointerEvent, d: Device) {
    if (connectMode) return; // in connect mode, clicks wire cables instead
    e.stopPropagation();
    const rect = wrapRef.current!.getBoundingClientRect();
    dragRef.current = {
      id: d.id,
      offX: e.clientX - rect.left - d.x,
      offY: e.clientY - rect.top - d.y,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onNodePointerMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const rect = wrapRef.current!.getBoundingClientRect();
    const x = Math.max(0, e.clientX - rect.left - drag.offX);
    const y = Math.max(0, e.clientY - rect.top - drag.offY);
    moveDevice(drag.id, Math.round(x), Math.round(y));
  }

  function onNodePointerUp(e: React.PointerEvent) {
    if (dragRef.current) {
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
      dragRef.current = null;
    }
  }

  function onNodeClick(e: React.MouseEvent, d: Device) {
    e.stopPropagation();
    if (connectMode) {
      clickConnect(d.id);
    } else {
      selectDevice(d.id);
    }
  }

  // ---- HTML5 drop from the palette ----
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDropActive(false);
    // The bar list covers the canvas; a device dropped on it would land behind
    // the list on a canvas the student isn't looking at.
    if (browsing) return;
    const kind = e.dataTransfer.getData('application/geekednet-kind');
    if (!kind) return;
    const rect = wrapRef.current!.getBoundingClientRect();
    const x = Math.round(e.clientX - rect.left - NODE_W / 2);
    const y = Math.round(e.clientY - rect.top - BOX_H / 2);
    addDevice(kind as Device['kind'], Math.max(0, x), Math.max(0, y));
  }

  function onCanvasMouseMove(e: React.MouseEvent) {
    if (!connectSourceId) return;
    const rect = wrapRef.current!.getBoundingClientRect();
    setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  }

  // One label per cable end, placed clear of the node it belongs to. Built here
  // rather than inside the cable <g> so they can be drawn in their own layer on
  // top of the device nodes.
  const portLabels: PortLabel[] = [];
  for (const link of net.links) {
    const a = deviceForIface(net, link.a.deviceId);
    const b = deviceForIface(net, link.b.deviceId);
    if (!a || !b) continue;
    const ifaceA = a.interfaces.find((i) => i.id === link.a.ifaceId);
    const ifaceB = b.interfaces.find((i) => i.id === link.b.ifaceId);
    if (ifaceA) portLabels.push(portLabel(`${link.id}-a`, a, b, ifaceA.name));
    if (ifaceB) portLabels.push(portLabel(`${link.id}-b`, b, a, ifaceB.name));
  }

  const sourceDevice = connectSourceId ? deviceForIface(net, connectSourceId) : undefined;

  return (
    <div
      ref={wrapRef}
      className={`canvas-wrap${dropActive ? ' drop-active' : ''}${winOpen ? ' win-open' : ''}`}
      onPointerMove={onNodePointerMove}
      onPointerUp={onNodePointerUp}
      onMouseMove={onCanvasMouseMove}
      onDragOver={(e) => {
        e.preventDefault();
        if (!browsing) setDropActive(true);
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={onDrop}
      onClick={() => {
        if (!connectMode) selectDevice(null);
      }}
    >
      {!browsing && (
        <CanvasToolbar connectMode={connectMode} toggleConnect={toggleConnect} demo={demo} />
      )}

      <svg className="canvas-svg">
        {/* cables */}
        {net.links.map((link) => {
          const a = deviceForIface(net, link.a.deviceId);
          const b = deviceForIface(net, link.b.deviceId);
          if (!a || !b) return null;
          const ca = center(a);
          const cb = center(b);
          const up = a.powered && b.powered;
          return (
            <g key={link.id}>
              <line x1={ca.x} y1={ca.y} x2={cb.x} y2={cb.y} className={`cable ${up ? 'up' : 'down'}`} />
              <line
                x1={ca.x}
                y1={ca.y}
                x2={cb.x}
                y2={cb.y}
                className="cable hit"
                onClick={(e) => {
                  e.stopPropagation();
                  removeLink(link.id);
                }}
              >
                <title>Click to remove cable</title>
              </line>
            </g>
          );
        })}

        {/* pending connect line */}
        {sourceDevice && cursor && (
          <line
            x1={center(sourceDevice).x}
            y1={center(sourceDevice).y}
            x2={cursor.x}
            y2={cursor.y}
            className="cable-pending"
          />
        )}

        {/* Under the one-shot packet: the ambient pulse is background texture,
            a live ping is the thing being watched. */}
        {ambientPath && <AmbientLink net={net} path={ambientPath} />}
        {packet && <Packet key={packet.id} net={net} packet={packet} onArrive={packetArrived} />}
      </svg>

      {/* device nodes */}
      {net.devices.map((d) => {
        const primary = d.interfaces.find((i) => i.ip);
        // The corner indicator is a link light, not a power light: it reports
        // what the engine says about this device's cabling right now, so pulling
        // a cable changes it on the next render with nothing else to do.
        const link = deviceLinkStatus(net, d.id);
        const classes = ['node'];
        classes.push(d.powered ? 'powered' : 'off');
        if (d.id === selectedId) classes.push('selected');
        if (connectMode) classes.push('connectable');
        if (d.id === connectSourceId) classes.push('connect-source');
        return (
          <div
            key={d.id}
            className={classes.join(' ')}
            style={{ left: d.x, top: d.y }}
            onPointerDown={(e) => onNodePointerDown(e, d)}
            onClick={(e) => onNodeClick(e, d)}
            onContextMenu={(e) => onNodeContextMenu(e, d)}
          >
            <div className="box">
              <span className={`stat ${link.health}`} title={link.reason} />
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" style={{ color: 'var(--brand-cyan)' }} dangerouslySetInnerHTML={{ __html: deviceIcon(d.kind) }} />
            </div>
            <div className="lbl">{d.label}</div>
            <div className="ip">{primary?.ip ?? ''}</div>
          </div>
        );
      })}

      {/* Interface labels ride in their own layer above the nodes, so a box can
          never cover its own port name. Pointer-events stay off — the cables
          underneath keep their click-to-remove hit area. */}
      <svg className="canvas-labels">
        {portLabels.map((l) => (
          <g key={l.key} className="port-label">
            <rect x={l.x - l.w / 2} y={l.y - LABEL_H / 2} width={l.w} height={LABEL_H} rx={7} />
            <text x={l.x} y={l.y} textAnchor="middle" dominantBaseline="central">
              {l.text}
            </text>
          </g>
        ))}
      </svg>

      {net.devices.length === 0 && !browsing && (
        <div className="canvas-empty">
          Drag a PC, Switch, or Router here to start building.
        </div>
      )}

      {browsing && <TopologyBrowser />}

      {menu && (
        <div
          className="node-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="node-menu-item danger"
            onClick={() => {
              setMenu(null);
              removeDevice(menu.deviceId);
            }}
          >
            Delete device
          </button>
        </div>
      )}

      {/* Destructive, one keystroke away, and the cables go with it — so the way
          back is on screen rather than left to a shortcut nobody was told about.
          The click is stopped here: undo re-selects what it restored, and
          bubbling to the canvas would clear that in the same gesture. */}
      {lastDeleted && (
        <div className="undo-chip" role="status" onClick={(e) => e.stopPropagation()}>
          <span>
            <b>{lastDeleted.label}</b> removed
          </span>
          <button className="undo-btn" onClick={undoDelete}>
            Undo
          </button>
          <button className="undo-x" onClick={dismissUndo} title="Dismiss">
            ×
          </button>
        </div>
      )}

      {lastResult && (
        <div className={`result-banner ${lastResult.success ? 'ok' : 'fail'}`} onClick={dismissResult}>
          {!lastResult.success
            ? `✗ ${lastResult.reason ?? 'unreachable'}`
            : lastResult.broadcast
              ? `✓ Broadcast to ${lastResult.target ?? 'the segment'} — ${
                  lastResult.recipients?.length ?? 0
                } ${lastResult.recipients?.length === 1 ? 'host' : 'hosts'} replied.`
              : `✓ Reply from ${lastResult.target ?? 'host'} — packet delivered.`}
        </div>
      )}

      {/* Pip belongs to whatever is on the canvas. Over the bar list there is no
          shape to explain yet, so he waits for one. */}
      {!browsing && <CompanionBot />}
      <WinBar />
    </div>
  );
}

function CanvasToolbar({
  connectMode,
  toggleConnect,
  demo,
}: {
  connectMode: boolean;
  toggleConnect: () => void;
  /** Set when a Learn Topology shape is loaded, rather than a lab. */
  demo: TopologyDemo | null;
}) {
  return (
    <div className="canvas-toolbar">
      {demo && <TopologyControls demo={demo} />}
      <button className={`btn${connectMode ? ' active' : ''}`} onClick={toggleConnect}>
        {connectMode ? '✕ Cancel wiring' : '⌁ Connect cables'}
      </button>
      <span className="hint-pill">
        {connectMode
          ? 'Click a device, then another, to run a cable between them.'
          : demo
            ? `${demo.name} — edit it freely: drag, re-cable, re-address, delete. Ask Pip what it is.`
            : 'Drag to move · click to configure · click a cable to remove it · right-click a device, or select it and press Delete, to remove it'}
      </span>
    </div>
  );
}

interface Pt {
  x: number;
  y: number;
}

/**
 * How long the packet takes to cross the whole path.
 *
 * A lab's verifying run is deliberately much quicker than a routine ping — same
 * cable, different urgency. The student should be able to tell the sign-off run
 * from an ordinary ping without being told which is which.
 */
function packetDuration(total: number, verify: boolean): number {
  return verify
    ? Math.min(620, Math.max(220, total * 1.15))
    : Math.min(2200, Math.max(700, total * 4));
}

/** How much neon streak is dragged behind the head on a verifying run. */
const TRAIL_LEN = 130;

/** The point `dist` px along the polyline. */
function pointAt(points: Pt[], segs: number[], dist: number): Pt {
  let acc = 0;
  let idx = 0;
  while (idx < segs.length - 1 && acc + segs[idx] < dist) {
    acc += segs[idx];
    idx += 1;
  }
  const local = Math.max(0, Math.min(1, (dist - acc) / (segs[idx] || 1)));
  const p0 = points[idx];
  const p1 = points[idx + 1] ?? p0;
  return { x: p0.x + (p1.x - p0.x) * local, y: p0.y + (p1.y - p0.y) * local };
}

/** The stretch of path between two distances, corners included — so the streak
 *  bends around a hop instead of cutting the corner. */
function slicePath(points: Pt[], segs: number[], from: number, to: number): Pt[] {
  const out: Pt[] = [pointAt(points, segs, from)];
  let acc = 0;
  for (let i = 0; i < segs.length; i += 1) {
    acc += segs[i];
    if (acc > from && acc < to) out.push(points[i + 1]);
  }
  out.push(pointAt(points, segs, to));
  return out;
}

/** A route ready to draw on: every device centre along it, the length of each
 *  cable between them, and the run total. */
interface RouteGeo {
  points: Pt[];
  segs: number[];
  total: number;
}

/**
 * Live geometry for one already-expanded cable run. Cheap enough to call every
 * frame, which is the point: packets are positioned against the network as it is
 * right now, so dragging a device mid-flight drags the packets onto its new
 * cables instead of leaving them hanging in the air.
 *
 * Takes the run device-by-device rather than the engine's hop list, because a
 * fan-out has several runs and each has to be expanded on its own before any of
 * them can be measured.
 */
function routeGeometry(net: NetworkState, route: string[]): RouteGeo | null {
  const points = route
    .map((id) => net.devices.find((d) => d.id === id))
    .filter((d): d is Device => !!d)
    .map(center);
  if (points.length === 0) return null;
  if (points.length === 1) return { points, segs: [], total: 0 };
  const segs = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  return { points, segs, total: segs.reduce((a, b) => a + b, 0) };
}

/** Where a packet sits `fraction` of the way along a route, streak included. */
function headAt(geo: RouteGeo, fraction: number, trailLen: number): Head {
  const dist = fraction * geo.total;
  return {
    pos: pointAt(geo.points, geo.segs, dist),
    trail:
      trailLen > 0 && geo.total > 0
        ? slicePath(geo.points, geo.segs, Math.max(0, dist - trailLen), dist)
        : null,
  };
}

/** The verifying run is a burst of three, not a single packet: one dot is a
 *  ping, three in convoy read as a deliberate proof. The bar waits for the last
 *  one, so this count is also how long the student watches before it rises. */
const VERIFY_PACKETS = 3;
/** Gap between the three launches. */
const VERIFY_STAGGER = 130;

/** One head in flight, with its streak. */
interface Head {
  pos: Pt;
  trail: Pt[] | null;
}

/**
 * One glowing packet: the bloom itself plus the streak it drags behind.
 *
 * Shared by the verifying burst and the idle loop, so they are the same object
 * at two intensities — the loop differs only in radius, trail length and the
 * `.ambient` class that turns the glow down.
 */
function PacketHead({
  gradId,
  head,
  r,
  className,
}: {
  gradId: string;
  head: Head;
  r: number;
  className: string;
}) {
  const tail = head.trail?.[0];
  return (
    <g>
      {tail && head.trail && head.trail.length > 1 && (
        <>
          <defs>
            {/* Oriented tail → head in canvas space, so the streak fades out
                behind the packet whichever way the cable runs. Literal hex on
                purpose: var() in an SVG presentation attribute is not
                substituted the way it is in a stylesheet. */}
            <linearGradient
              id={gradId}
              gradientUnits="userSpaceOnUse"
              x1={tail.x}
              y1={tail.y}
              x2={head.pos.x}
              y2={head.pos.y}
            >
              <stop offset="0%" stopColor="#22d3ee" stopOpacity="0" />
              <stop offset="65%" stopColor="#67e8f9" stopOpacity="0.7" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="1" />
            </linearGradient>
          </defs>
          <polyline
            className="packet-streak"
            stroke={`url(#${gradId})`}
            points={head.trail.map((p) => `${p.x},${p.y}`).join(' ')}
          />
        </>
      )}
      <circle cx={head.pos.x} cy={head.pos.y} r={r} className={className} />
    </g>
  );
}

/**
 * Where a packet stopped short, ringed on the canvas.
 *
 * A head that simply parks on a device is easy to miss on a busy canvas, and the
 * one thing a blocked packet has to communicate is *which* device turned it
 * away. The banner and the terminal carry the why; this carries the where.
 */
function BlockedMarker({ net, deviceId }: { net: NetworkState; deviceId: string }) {
  const d = net.devices.find((x) => x.id === deviceId);
  if (!d) return null;
  return (
    <rect
      className="packet-blocked"
      x={d.x - 7}
      y={d.y - 7}
      width={NODE_W + 14}
      height={BOX_H + 14}
      rx={15}
    />
  );
}

/**
 * Animates the packet: a glowing dot at the usual pace, or — for the run that
 * verifies a lab — three bright neon streaks at speed, launched in convoy.
 * Reports `onArrive` once the last of them reaches the far end; the store holds
 * the win bar back until then, so the two never overlap.
 *
 * A broadcast travels several routes at once. Every head moves at one shared
 * speed rather than one shared duration, which is what makes the fan-out read
 * correctly: while the routes share cables the heads sit exactly on top of each
 * other — one frame on one wire — and they separate at the precise device where
 * the cabling itself separates. A short branch simply finishes first.
 *
 * Exported because the phone layout draws packets on its own tap-only SVG and
 * must draw them with *this* animator: it is the one that walks the real cable
 * routes, and a second copy of it would be a second answer to "where does a
 * packet actually go".
 */
export function Packet({
  net,
  packet,
  onArrive,
  sizeScale = 1,
}: {
  net: NetworkState;
  packet: PacketAnim;
  onArrive: (packetId: number) => void;
  /**
   * Multiplier on the head and its streak — the glowing furniture, never the
   * route. The phone's SVG shrinks a desktop-sized layout to fit a handset, and
   * a 5.5px dot scaled with it stops being visible; this puts the size back
   * without moving the packet off the cable it is on. Defaults to 1, which is
   * the desktop canvas exactly as before.
   */
  sizeScale?: number;
}) {
  const [heads, setHeads] = useState<Head[]>([]);
  // Read live rather than depended on: a device dragged mid-flight re-routes the
  // cables under the packets instead of tearing the animation down and
  // relaunching it from the start.
  const netRef = useRef(net);
  netRef.current = net;

  useEffect(() => {
    // Re-derived every frame from the live network, so a drag re-routes the
    // branches too — and `packetCableRoutes` drops any run it cannot walk on
    // real cable, so a head never crosses a link that is not on the canvas.
    const geometry = (): RouteGeo[] =>
      packetCableRoutes(netRef.current, packet.path, packet.recipients)
        .map((route) => routeGeometry(netRef.current, route))
        .filter((g): g is RouteGeo => !!g && g.total > 0);

    const initial = geometry();
    // Nowhere to travel, but arrival is still reported: a verification that
    // never reports would leave the lab hanging.
    if (initial.length === 0) {
      const src = netRef.current.devices.find((d) => d.id === packet.path[0]);
      setHeads(src ? [{ pos: center(src), trail: null }] : []);
      onArrive(packet.id);
      return;
    }

    // The run lasts as long as its longest branch, and everything moves at the
    // speed that implies — so branches sharing cable stay superimposed and part
    // company exactly where the cabling does.
    const longest = Math.max(...initial.map((g) => g.total));
    const flight = packetDuration(longest, packet.verify);
    const speed = longest / flight; // px per ms, shared by every head
    const count = packet.verify ? VERIFY_PACKETS : 1;
    const stagger = packet.verify ? VERIFY_STAGGER : 0;
    const duration = flight + (count - 1) * stagger;
    const start = performance.now();
    let raf = 0;

    const tick = (now: number) => {
      const elapsed = now - start;
      // Distance travelled is the shared quantity, mapped onto each route as it
      // is this frame, so the packets stay glued to the cables however they move.
      const live = geometry();
      if (live.length > 0) {
        const next: Head[] = [];
        for (const geo of live) {
          for (let i = 0; i < count; i += 1) {
            const travelled = (elapsed - i * stagger) * speed;
            if (travelled < 0) continue; // not launched yet
            const p = travelled / geo.total;
            // A verifying packet is spent once it lands; an ordinary one stays
            // put at the destination, the way it always has.
            if (p >= 1 && packet.verify) continue;
            next.push(headAt(geo, Math.min(1, p), packet.verify ? TRAIL_LEN * sizeScale : 0));
          }
        }
        setHeads(next);
      }
      if (elapsed < duration) {
        raf = requestAnimationFrame(tick);
      } else {
        onArrive(packet.id);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [packet.id, packet.verify, packet.path, packet.recipients, onArrive, sizeScale]);

  const stoppedAt = blockedAt(packet.path, packet.success);

  return (
    <g>
      {stoppedAt && <BlockedMarker net={net} deviceId={stoppedAt} />}
      {heads.map((head, i) => (
        <PacketHead
          key={i}
          gradId={`packet-streak-${packet.id}-${i}`}
          head={head}
          r={(packet.verify ? 7 : 5.5) * sizeScale}
          className={`packet${packet.success ? '' : ' fail'}${packet.verify ? ' verify' : ''}`}
        />
      ))}
    </g>
  );
}

/** Idle travel speed in px/ms. Set as a speed rather than a fixed lap time so a
 *  four-hop lab doesn't race to keep pace with a two-hop one — roughly an eighth
 *  of a verifying run either way. */
const AMBIENT_SPEED = 0.11;
/** …but a very short link shouldn't buzz, so a lap never dips under this. */
const AMBIENT_MIN_LAP = 2400;
/** Dots in the loop, spaced evenly around the lap. */
const AMBIENT_DOTS = 2;
/** A stub of a streak — enough to read as the same object as a verifying packet,
 *  short enough not to look like traffic. */
const AMBIENT_TRAIL_LEN = 46;

const ambientLapMs = (total: number): number =>
  Math.max(AMBIENT_MIN_LAP, total / AMBIENT_SPEED);

/** Does this viewer want motion kept to a minimum? Re-read on change, so
 *  flipping the OS setting takes effect without a reload. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/**
 * The "link alive" loop that outlasts the verifying burst: the same glowing
 * packets, turned down and slowed right down, circulating along the route the
 * student just proved — hop by hop through every switch and router on it, behind
 * the win bar.
 *
 * Deliberately quieter than anything else that moves on this canvas — it is
 * ambience, not feedback. It stops when the store drops `ambientPath` (the bar
 * dismissed, or the next lab loaded), pauses while the tab is hidden, and never
 * starts at all under `prefers-reduced-motion`.
 *
 * Exported alongside {@link Packet}: on the phone it is what explains where a
 * landed packet went, and it has to trace the same cables.
 */
export function AmbientLink({
  net,
  path,
  sizeScale = 1,
}: {
  net: NetworkState;
  path: string[];
  /** See {@link Packet}'s `sizeScale`. */
  sizeScale?: number;
}) {
  const [dots, setDots] = useState<Head[]>([]);
  const reduced = useReducedMotion();
  // Same trick as Packet: the loop reads the live network every frame instead of
  // restarting whenever it changes. Dragging a device re-routes the cables under
  // the packets without the loop stuttering or snapping back to the start.
  const netRef = useRef(net);
  netRef.current = net;
  // Kept across re-runs for the same reason — progress is the one thing that
  // must survive a topology change.
  const phase = useRef(0);

  useEffect(() => {
    if (reduced) {
      setDots([]);
      return;
    }

    let raf = 0;
    let last = 0;

    const tick = (now: number) => {
      const geo = routeGeometry(netRef.current, cableRoute(netRef.current, path));
      if (geo && geo.total > 0) {
        // Advanced by elapsed time rather than wall clock, so a pause resumes
        // where it left off instead of jumping.
        phase.current = (phase.current + (now - last) / ambientLapMs(geo.total)) % 1;
        setDots(
          Array.from({ length: AMBIENT_DOTS }, (_, i) =>
            headAt(geo, (phase.current + i / AMBIENT_DOTS) % 1, AMBIENT_TRAIL_LEN * sizeScale),
          ),
        );
      } else {
        setDots([]);
      }
      last = now;
      raf = requestAnimationFrame(tick);
    };
    const play = () => {
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };
    const pause = () => cancelAnimationFrame(raf);

    // A hidden tab throttles rAF to a standstill anyway; stopping explicitly
    // means no stale frame is left mid-flight when it comes back, either.
    const onVisibility = () => {
      pause();
      if (!document.hidden) play();
    };
    if (!document.hidden) play();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      pause();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [path, reduced, sizeScale]);

  return (
    <g className="ambient-link">
      {dots.map((head, i) => (
        <PacketHead
          key={i}
          gradId={`ambient-streak-${i}`}
          head={head}
          r={4 * sizeScale}
          className="packet ambient"
        />
      ))}
    </g>
  );
}
