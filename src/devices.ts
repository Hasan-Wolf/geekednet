/**
 * UI-side device catalogue: how the palette turns a dropped icon into a
 * schema-correct {@link Device}. This is presentation/authoring data — the engine
 * never sees it; it only ever receives fully-formed `Device` objects.
 */
import type { Device, DeviceKind, Interface } from '../engine/index.js';

export interface PaletteEntry {
  kind: DeviceKind;
  label: string;
  sub: string;
  /** How many interfaces a freshly-dropped device of this kind gets. */
  makeInterfaces: () => Interface[];
  routesEnabled: boolean;
}

let seq = 0;
export function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

function ports(count: number, name: string, prefix: string): Interface[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i + 1}`,
    name: `${name}${i + 1}`,
    ip: null,
    mask: null,
    linkId: null,
  }));
}

export const PALETTE: PaletteEntry[] = [
  {
    kind: 'pc',
    label: 'PC',
    sub: 'End host · 1 NIC',
    routesEnabled: false,
    makeInterfaces: () => [{ id: 'e0', name: 'eth0', ip: null, mask: null, linkId: null }],
  },
  {
    kind: 'switch',
    label: 'Switch',
    sub: 'Layer 2 · 6 ports',
    routesEnabled: false,
    makeInterfaces: () => ports(6, 'port', 'p'),
  },
  {
    kind: 'router',
    label: 'Router',
    sub: 'Layer 3 · 4 ports',
    routesEnabled: true,
    makeInterfaces: () => ports(4, 'ether', 'g'),
  },
];

/** Build a new schema-correct device of `kind` at (x, y). */
export function makeDevice(kind: DeviceKind, x: number, y: number, label: string): Device {
  const entry = PALETTE.find((p) => p.kind === kind)!;
  const device: Device = {
    id: nextId(kind),
    kind,
    label,
    interfaces: entry.makeInterfaces(),
    powered: true,
    x,
    y,
  };
  if (entry.routesEnabled) device.routes = [];
  return device;
}

/** Inline SVG icon per device kind (stroke is set by caller via currentColor). */
export function deviceIcon(kind: DeviceKind): string {
  switch (kind) {
    case 'switch':
    case 'hub':
      return '<rect x="2" y="8" width="20" height="8" rx="1.5"/><path d="M6 12h.01M10 12h.01M14 12h.01M18 12h.01"/>';
    case 'router':
      return '<circle cx="12" cy="12" r="9"/><path d="M8 12h8M12 8l4 4-4 4M16 12l-4-4M16 12l-4 4"/>';
    case 'server':
      return '<rect x="4" y="3" width="16" height="8" rx="1.5"/><rect x="4" y="13" width="16" height="8" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>';
    case 'firewall':
      return '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 9h18M3 15h18M9 4v5M15 9v6M9 15v5"/>';
    case 'pc':
    case 'laptop':
    default:
      return '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>';
  }
}
