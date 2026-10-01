/**
 * The phone canvas: the same network, as one tap-only SVG.
 *
 * Everything that makes the desktop canvas a *builder* is absent here — no drag
 * to place, no drag to move, no click-to-connect, no cable to remove, no
 * right-click menu, no drop target. A tap selects a device so its config can be
 * read; that is the whole interaction.
 *
 * What it does keep is the geometry. Devices are drawn at the lab's own
 * coordinates, at the same footprint the desktop renderer uses, so `center()`,
 * `cableRoute()` and the shared {@link Packet} animator all mean exactly what
 * they mean on desktop: a packet crosses the real cables, through every switch
 * and router on the way. The whole layout is then fitted to the screen by the
 * `viewBox` alone — one uniform scale, nothing re-laid-out, nothing re-authored.
 */
import { deviceLinkStatus, type Device, type NetworkState } from '../../engine/index.js';
import { BOX_H, NODE_W, Packet, AmbientLink, center } from '../components/Canvas.js';
import { deviceIcon } from '../devices.js';
import { useStore } from '../store.js';

/** Breathing room around the outermost device footprints, in layout units. */
const PAD = 22;

/**
 * Room under a device's box for its name and address.
 *
 * Deliberately not the desktop's `NODE_TEXT_H`: the phone sets both lines a few
 * points larger, because the whole layout arrives at the screen shrunk and the
 * desktop's 12px name would land at about seven.
 */
const TEXT_H = 44;
const LABEL_Y = 18;
const IP_Y = 34;

/** Icon side, centred in the box. Matches the desktop's 30px glyph. */
const ICON = 30;

/** How far outside its box a device still counts as tapped, in layout units.
 *  A shrunk 92x60 box is a small target on a handset; this brings it back up. */
const HIT_PAD = 12;

/**
 * Size multiplier for the glowing packet furniture.
 *
 * A lab's layout is roughly 500–650 units wide and a phone gives it about 360,
 * so the whole drawing lands at ~0.55–0.7 scale — and a 5.5-unit packet head
 * scaled with it is 3px of glow on a busy background. This puts the head back
 * to about its desktop size on screen without touching the route it travels.
 */
const PACKET_SIZE_SCALE = 1.7;

export interface CanvasBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The `viewBox` that holds the whole network — every device footprint, its two
 * lines of text, and a margin.
 *
 * Exported so the tests can check it against the real renderer's metrics rather
 * than against a copy of them: a device outside this box is a device the phone
 * clips off the screen.
 */
export function canvasBounds(net: NetworkState): CanvasBounds {
  if (net.devices.length === 0) return { x: 0, y: 0, w: NODE_W + PAD * 2, h: BOX_H + PAD * 2 };
  const minX = Math.min(...net.devices.map((d) => d.x));
  const maxX = Math.max(...net.devices.map((d) => d.x + NODE_W));
  const minY = Math.min(...net.devices.map((d) => d.y));
  const maxY = Math.max(...net.devices.map((d) => d.y + BOX_H + TEXT_H));
  return {
    x: minX - PAD,
    y: minY - PAD,
    w: maxX - minX + PAD * 2,
    h: maxY - minY + PAD * 2,
  };
}

/** The address a node prints under its name — the first one it carries. */
function primaryIp(device: Device): string | undefined {
  return device.interfaces.find((i) => i.ip)?.ip ?? undefined;
}

export function PhoneCanvas() {
  const net = useStore((s) => s.network);
  const selectedId = useStore((s) => s.selectedDeviceId);
  const selectDevice = useStore((s) => s.selectDevice);
  const packet = useStore((s) => s.packet);
  const packetArrived = useStore((s) => s.packetArrived);
  const ambientPath = useStore((s) => s.ambientPath);

  const b = canvasBounds(net);

  return (
    <div className="ph-canvas-frame">
      <svg
        className="ph-canvas"
        viewBox={`${b.x} ${b.y} ${b.w} ${b.h}`}
        style={{ aspectRatio: `${b.w} / ${b.h}` }}
        preserveAspectRatio="xMidYMid meet"
      >
        {/* cables — the same up/down colouring the desktop uses */}
        {net.links.map((link) => {
          const a = net.devices.find((d) => d.id === link.a.deviceId);
          const z = net.devices.find((d) => d.id === link.b.deviceId);
          if (!a || !z) return null;
          const ca = center(a);
          const cz = center(z);
          return (
            <line
              key={link.id}
              x1={ca.x}
              y1={ca.y}
              x2={cz.x}
              y2={cz.y}
              className={`cable ${a.powered && z.powered ? 'up' : 'down'}`}
            />
          );
        })}

        {/* Under the nodes: it is ambience, and it is what explains where the
            packet that just landed went. */}
        {ambientPath && (
          <AmbientLink net={net} path={ambientPath} sizeScale={PACKET_SIZE_SCALE} />
        )}

        {net.devices.map((d) => {
          const link = deviceLinkStatus(net, d.id);
          const ip = primaryIp(d);
          const selected = d.id === selectedId;
          return (
            <g
              key={d.id}
              className={`ph-node ${d.powered ? 'powered' : 'off'}${selected ? ' selected' : ''}`}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={`${d.label} — ${d.kind}${ip ? `, ${ip}` : ''}. ${link.reason}`}
              onClick={() => selectDevice(selected ? null : d.id)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                selectDevice(selected ? null : d.id);
              }}
            >
              {/* Tap target first, so it sits under the artwork it enlarges. */}
              <rect
                className="ph-hit"
                x={d.x - HIT_PAD}
                y={d.y - HIT_PAD}
                width={NODE_W + HIT_PAD * 2}
                height={BOX_H + TEXT_H + HIT_PAD}
                rx={16}
              />
              <rect
                className="ph-box"
                x={d.x}
                y={d.y}
                width={NODE_W}
                height={BOX_H}
                rx={14}
              />
              <svg
                x={d.x + (NODE_W - ICON) / 2}
                y={d.y + (BOX_H - ICON) / 2}
                width={ICON}
                height={ICON}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                className="ph-icon"
                dangerouslySetInnerHTML={{ __html: deviceIcon(d.kind) }}
              />
              {/* Link light, not a power light — the engine's own reading of
                  this device's cabling, exactly as on desktop. */}
              <circle className={`ph-stat ${link.health}`} cx={d.x + NODE_W} cy={d.y} r={6} />
              <text
                className="ph-lbl"
                x={d.x + NODE_W / 2}
                y={d.y + BOX_H + LABEL_Y}
                textAnchor="middle"
              >
                {d.label}
              </text>
              {ip && (
                <text
                  className="ph-ip"
                  x={d.x + NODE_W / 2}
                  y={d.y + BOX_H + IP_Y}
                  textAnchor="middle"
                >
                  {ip}
                </text>
              )}
            </g>
          );
        })}

        {/* Above the nodes: on a screen this size the arrival is the point, and
            a head that ducks behind the destination box is an arrival missed. */}
        {packet && (
          <Packet
            key={packet.id}
            net={net}
            packet={packet}
            onArrive={packetArrived}
            sizeScale={PACKET_SIZE_SCALE}
          />
        )}
      </svg>
    </div>
  );
}
