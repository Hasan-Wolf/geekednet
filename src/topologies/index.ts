/**
 * Learn Topology registry — the seven shapes, as data.
 *
 * A topology demo is one entry in `topologies.json`: the researched explanation
 * Pip reads out, plus an `initialState` in exactly the shape a lab's
 * `initialState` uses (see `engine/labs/*.json`). Adding an eighth shape is
 * adding an eighth entry to that file — no code in this directory, the canvas,
 * the renderer or the store learns its name.
 *
 * What a demo is *not* is a {@link Lab}. It has no objectives, grants no XP and
 * never touches progression, so it is deliberately its own type rather than a
 * Lab with the lesson fields left empty — and nothing here changes the engine or
 * the lab schema.
 *
 * Provenance: every prose field (`oneLine`, `status`, `statusLabel`, `whatItIs`,
 * `howDataTravels`, `whereUsedToday`, `advantages`, `drawbacks`, `goodToKnow`,
 * `_sources`) is copied verbatim from the researched `topology-content.json`
 * that ships with the content pack. It is reviewed writing, not generated text:
 * edit it there, re-copy it here, don't paraphrase it in code.
 */
import type { Device, NetworkState } from '../../engine/index.js';
import { neighbours } from '../cableRoute.js';
import raw from './topologies.json' with { type: 'json' };

/**
 * How current a shape is, which is the one thing a student most needs to know
 * before spending time on it. Rendered as the badge on each bar.
 */
export type TopologyStatus = 'current' | 'specialized' | 'historical';

export const TOPOLOGY_STATUSES: readonly TopologyStatus[] = [
  'current',
  'specialized',
  'historical',
];

/** Pip's explanation, kept as separate fields so it renders as sections rather
 *  than one wall of text. */
export interface TopologyExplanation {
  whatItIs: string;
  howDataTravels: string;
  whereUsedToday: string;
  advantages: string[];
  drawbacks: string[];
  goodToKnow: string;
  /** Where the claims come from, shown as a footnote. Optional: a future entry
   *  may cite nothing. */
  sources?: string[];
}

export interface TopologyDemo {
  id: string;
  name: string;
  /** One line, shown on the bar under the name. */
  oneLine: string;
  status: TopologyStatus;
  /** The badge's tooltip / long form — "Obsolete — you will not build one…". */
  statusLabel: string;
  explanation: TopologyExplanation;
  /** Fully built and fully addressed, the same shape as `Lab.initialState`. */
  initialState: NetworkState;
}

/** Thrown when an entry in `topologies.json` doesn't match what the UI renders. */
export class TopologySchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TopologySchemaError';
  }
}

function str(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TopologySchemaError(`${where}: expected a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function strList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TopologySchemaError(`${where}: expected a non-empty array of strings`);
  }
  return value.map((v, i) => str(v, `${where}[${i}]`));
}

/**
 * Check a demo's network the way the canvas will read it.
 *
 * Every failure here is the kind that looks like a broken simulator rather than
 * a broken data file: a cable pointing at a port that doesn't exist draws
 * nothing, a port holding a stale `linkId` makes the engine think a device is
 * plugged in when it isn't. Both are one typo away while hand-authoring, so they
 * throw at import — named — instead of at play time.
 */
function validateNetwork(state: unknown, where: string): NetworkState {
  const net = state as NetworkState | undefined;
  if (!net || !Array.isArray(net.devices) || !Array.isArray(net.links)) {
    throw new TopologySchemaError(`${where}: initialState needs a devices[] and a links[]`);
  }
  if (net.devices.length === 0) {
    throw new TopologySchemaError(`${where}: initialState has no devices`);
  }

  const byId = new Map<string, Device>();
  for (const device of net.devices) {
    str(device.id, `${where} device id`);
    if (byId.has(device.id)) {
      throw new TopologySchemaError(`${where}: two devices share the id "${device.id}"`);
    }
    str(device.label, `${where} device ${device.id} label`);
    if (!Array.isArray(device.interfaces) || device.interfaces.length === 0) {
      throw new TopologySchemaError(`${where}: device ${device.id} has no interfaces`);
    }
    byId.set(device.id, device);
  }

  const linkIds = new Set<string>();
  for (const link of net.links) {
    str(link.id, `${where} link id`);
    if (linkIds.has(link.id)) {
      throw new TopologySchemaError(`${where}: two links share the id "${link.id}"`);
    }
    linkIds.add(link.id);
    for (const end of [link.a, link.b]) {
      const device = byId.get(end?.deviceId);
      if (!device) {
        throw new TopologySchemaError(
          `${where}: link ${link.id} names device "${end?.deviceId}", which does not exist`,
        );
      }
      const iface = device.interfaces.find((i) => i.id === end.ifaceId);
      if (!iface) {
        throw new TopologySchemaError(
          `${where}: link ${link.id} names ${device.id}/"${end.ifaceId}", which is not an interface`,
        );
      }
      if (iface.linkId !== link.id) {
        throw new TopologySchemaError(
          `${where}: ${device.id}/${iface.id} carries linkId "${iface.linkId}" but link ${link.id} claims it`,
        );
      }
    }
  }

  // The mirror of the check above: a port that names a cable nobody laid.
  for (const device of net.devices) {
    for (const iface of device.interfaces) {
      if (iface.linkId && !linkIds.has(iface.linkId)) {
        throw new TopologySchemaError(
          `${where}: ${device.id}/${iface.id} is plugged into "${iface.linkId}", which is not a link`,
        );
      }
    }
  }

  return net;
}

/** Turn one raw entry into a {@link TopologyDemo}, or throw naming the problem. */
export function validateTopology(entry: unknown): TopologyDemo {
  const e = entry as Record<string, unknown>;
  const id = str(e?.id, 'topology id');
  const where = `topology "${id}"`;

  const status = e.status;
  if (!TOPOLOGY_STATUSES.includes(status as TopologyStatus)) {
    throw new TopologySchemaError(
      `${where}: status must be one of ${TOPOLOGY_STATUSES.join(' / ')}, got ${JSON.stringify(status)}`,
    );
  }

  return {
    id,
    name: str(e.name, `${where} name`),
    oneLine: str(e.oneLine, `${where} oneLine`),
    status: status as TopologyStatus,
    statusLabel: str(e.statusLabel, `${where} statusLabel`),
    explanation: {
      whatItIs: str(e.whatItIs, `${where} whatItIs`),
      howDataTravels: str(e.howDataTravels, `${where} howDataTravels`),
      whereUsedToday: str(e.whereUsedToday, `${where} whereUsedToday`),
      advantages: strList(e.advantages, `${where} advantages`),
      drawbacks: strList(e.drawbacks, `${where} drawbacks`),
      goodToKnow: str(e.goodToKnow, `${where} goodToKnow`),
      sources: Array.isArray(e._sources) ? strList(e._sources, `${where} _sources`) : undefined,
    },
    initialState: validateNetwork(e.initialState, where),
  };
}

/** The bars, left to right, in file order. */
export const TOPOLOGIES: TopologyDemo[] = (raw as unknown[]).map(validateTopology);

export const topologiesById: Record<string, TopologyDemo> = Object.fromEntries(
  TOPOLOGIES.map((t) => [t.id, t]),
);

export function getTopology(id: string | null | undefined): TopologyDemo | undefined {
  return id ? topologiesById[id] : undefined;
}

/** The device kinds that own an address and can run a shell. */
const HOST_KINDS: ReadonlySet<Device['kind']> = new Set<Device['kind']>(['pc', 'laptop', 'server']);

/** Addressed hosts, in the order the topology lists them — so the first one is
 *  also the device the terminal opens on (see `defaultTerminalDevice`). */
function addressedHosts(net: NetworkState): Device[] {
  return net.devices.filter((d) => HOST_KINDS.has(d.kind) && d.interfaces.some((i) => i.ip));
}

/** Cable hops from `from` to every device reachable from it. */
function hopDistances(net: NetworkState, from: string): Map<string, number> {
  const dist = new Map<string, number>([[from, 0]]);
  const queue = [from];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const id of neighbours(net, cur)) {
      if (dist.has(id)) continue;
      dist.set(id, dist.get(cur)! + 1);
      queue.push(id);
    }
  }
  return dist;
}

/** The ping a demo suggests: which shell, and which address to aim at. */
export interface DemoPing {
  from: Device;
  to: Device;
  toIp: string;
}

/**
 * Pick the ping worth showing off, from the network alone.
 *
 * The shell opens on the topology's first host, so that is the sender. The
 * destination is the addressed host furthest from it by cable, because that is
 * the run that actually demonstrates the shape — the long way round a ring, the
 * trip up and over a tree, the hop across a hybrid's backbone. Derived, never
 * authored: a new topology gets a sensible suggestion without writing one.
 */
export function demoPing(net: NetworkState): DemoPing | null {
  const hosts = addressedHosts(net);
  const from = hosts[0];
  if (!from) return null;
  const dist = hopDistances(net, from.id);

  let best: Device | undefined;
  let bestDist = -1;
  for (const host of hosts.slice(1)) {
    const d = dist.get(host.id) ?? -1;
    if (d > bestDist) {
      best = host;
      bestDist = d;
    }
  }
  const toIp = best?.interfaces.find((i) => i.ip)?.ip;
  return best && toIp ? { from, to: best, toIp } : null;
}
