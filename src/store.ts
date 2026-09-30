/**
 * App state (Zustand) — the single wiring layer between the React UI and the pure
 * engine. Every mutation produces a fresh {@link NetworkState}, then re-evaluates
 * the active lab's objectives through the engine's `evaluateObjectives`. The store
 * imports the engine's public API only; it never reaches into engine internals and
 * changes no engine code.
 */
import { create } from 'zustand';
import {
  evaluateObjectives,
  getDevice,
  isVerifyPing,
  labStatus,
  labs as missionLabs,
  type Device,
  type DeviceKind,
  type Interface,
  type Lab,
  type Link,
  type NetworkState,
  type ObjectiveResult,
  type RouteEntry,
  type SimResult,
} from '../engine/index.js';
import { makeDevice, nextId } from './devices.js';
import { runCommand, type TermLine } from './terminalEngine.js';
import { TOPOLOGIES, demoPing, getTopology, type TopologyDemo } from './topologies/index.js';

// A free-build playground so "build Mission 1 from an empty canvas" is literal.
const SANDBOX: Lab = {
  id: 'sandbox',
  tier: 0,
  mode: 'practice',
  fidelity: 'A',
  title: 'Sandbox',
  brief:
    'Free build. Drag devices from the left, click Connect to run cables, then click a device to give it an IP. Open the terminal and ping across your network.',
  initialState: { devices: [], links: [] },
  objectives: [],
  hints: [{ level: 1, text: 'Drag two PCs and a switch, cable them up, and give the PCs IPs on the same /24.' }],
  botOpeners: ['Sandbox mode — build whatever you like. I’ll stay out of your way.'],
  rewards: { xp: 0 },
};

export const ALL_LABS: Lab[] = [SANDBOX, ...missionLabs];

const PERSIST_KEY = 'geekednet.progress.v1';

/** Where a fresh player starts, and where a progress reset returns them to. */
const START_LAB_ID = 'tier0-first-ping.learn';

interface PersistedProgress {
  xp: number;
  earnedBadges: string[];
  unlocked: string[];
  completedLabs: string[];
  labProgress: Record<string, { learn?: boolean; practice?: boolean; master?: number }>;
}

/** A blank slate: both the first-run state and what a progress reset restores.
 *  Built fresh per call so no caller can mutate the defaults in place. */
function defaultProgress(): PersistedProgress {
  return {
    xp: 0,
    earnedBadges: [],
    unlocked: ['sandbox', START_LAB_ID],
    completedLabs: [],
    labProgress: {},
  };
}

function loadProgress(): PersistedProgress {
  const fallback = defaultProgress();
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistedProgress>;
    return {
      ...fallback,
      ...parsed,
      unlocked: Array.from(new Set([...fallback.unlocked, ...(parsed.unlocked ?? [])])),
    };
  } catch {
    return fallback;
  }
}

function cloneState(state: NetworkState): NetworkState {
  return structuredClone(state);
}

/** Phase (color) for a tier — mirrors §4/§9. */
export function tierPhase(tier: number): 'setup' | 'build' | 'defend' | 'attack' {
  if (tier <= 1) return 'setup';
  if (tier <= 3) return 'build';
  if (tier === 4) return 'defend';
  return 'attack';
}

export interface PacketAnim {
  id: number;
  path: string[];
  success: boolean;
  /** The lab's sign-off run, drawn as a fast neon streak instead of the usual dot. */
  verify: boolean;
  /**
   * Every device that accepted a broadcast, straight from the engine.
   *
   * Set only for a broadcast. The canvas turns each one into its own cable run
   * out of the sender and puts a head on every branch, so a frame that reached
   * four machines is drawn reaching four machines.
   */
  recipients?: string[];
}

/**
 * Everything needed to put a deleted device back exactly as it was: the device
 * itself, and the cables that died with it.
 *
 * Snapshots are taken from the working copy before the mutation lands, so they
 * are already detached from live state — nothing here aliases the network.
 */
export interface DeletedDevice {
  device: Device;
  links: Link[];
  /** For the "PC3 deleted — Undo" offer, so it reads as the student named it. */
  label: string;
}

/**
 * How the active lab's completion is gated right now.
 *
 *  - `none`      nothing pending — still configuring, or the lab is already banked
 *  - `ready`     every objective is green; waiting on the student's verifying ping
 *  - `verifying` that ping succeeded and its packet is crossing the canvas
 *
 * A lab that declares no {@link Lab.verify} never leaves `none`: it completes the
 * moment its objectives do, exactly as before.
 */
export type VerifyStatus = 'none' | 'ready' | 'verifying';

interface AppState {
  labs: Lab[];
  activeLabId: string;

  /**
   * Learn Topology mode — the seven shapes, as demos.
   *
   * Orthogonal to `activeLabId` on purpose: a demo is not a lab, so it is not
   * one in the registry either. `topologyMode` says the phase is open;
   * `topologyId` says which shape is on the canvas, and `null` means the bar
   * list is up. Nothing in here is graded or persisted — see {@link ungraded}.
   */
  topologies: TopologyDemo[];
  topologyMode: boolean;
  topologyId: string | null;

  network: NetworkState;
  selectedDeviceId: string | null;
  objectiveResults: ObjectiveResult[];

  // canvas interaction
  connectMode: boolean;
  connectSourceId: string | null;

  // terminal
  terminalDeviceId: string | null;
  terminalLog: TermLine[];
  commandHistory: string[];

  // animation / last result
  packet: PacketAnim | null;
  lastResult: (SimResult & { target?: string }) | null;
  verifyStatus: VerifyStatus;
  /** The verified path, looped as an ambient "link alive" pulse under the win
   *  bar. Null whenever nothing is verified — which is also how the loop stops. */
  ambientPath: string[] | null;

  // progress / gamification
  xp: number;
  earnedBadges: string[];
  unlocked: string[];
  completedLabs: string[];
  labProgress: PersistedProgress['labProgress'];
  justCompleted: string | null;
  /** The reset-progress confirm dialog. Lives here because two very different
   *  places open it — the settings menu and the win bar — and it is rendered at
   *  the app root, above both of them. */
  resetConfirmOpen: boolean;
  /**
   * The one deletion that can still be taken back.
   *
   * Deleting a device is one keystroke and takes its cables with it, so the
   * canvas keeps the pieces until the next deletion supersedes them, the student
   * dismisses the offer, or the lab changes under it. Single level on purpose:
   * this is an "undo that mistake" affordance, not an edit history.
   */
  lastDeleted: DeletedDevice | null;

  // ---- actions ----
  loadLab: (id: string) => void;
  resetLab: () => void;
  /** Open Learn Topology on the bar list. */
  enterTopologyMode: () => void;
  /** Put a topology on the canvas, fully built and fully addressed. */
  loadTopology: (id: string) => void;
  /** Back to the bar list from a loaded topology. */
  backToTopologies: () => void;
  /** Undo every edit the student made to the loaded topology. */
  resetTopology: () => void;
  selectDevice: (id: string | null) => void;
  addDevice: (kind: DeviceKind, x: number, y: number) => void;
  moveDevice: (id: string, x: number, y: number) => void;
  removeDevice: (id: string) => void;
  /** Put the last deleted device and its cables back. No-op once the offer has
   *  lapsed, so a caller never has to check first. */
  undoDelete: () => void;
  /** Drop the undo offer without acting on it. */
  dismissUndo: () => void;
  setPower: (id: string, powered: boolean) => void;
  setIfaceField: (deviceId: string, ifaceId: string, field: 'ip' | 'mask', value: string) => void;
  setGateway: (deviceId: string, gateway: string) => void;
  addRoute: (deviceId: string) => void;
  updateRoute: (deviceId: string, index: number, field: keyof RouteEntry, value: string) => void;
  removeRoute: (deviceId: string, index: number) => void;

  toggleConnectMode: () => void;
  clickDeviceForConnect: (id: string) => void;
  removeLink: (linkId: string) => void;

  runTerminal: (raw: string) => void;
  clearTerminal: () => void;
  animatePath: (result: SimResult, target?: string, verify?: boolean) => void;
  /** The canvas reporting that a packet finished its run. */
  packetArrived: (packetId: number) => void;
  dismissResult: () => void;
  dismissCompletion: () => void;
  setResetConfirm: (open: boolean) => void;
  /** Wipe every persisted reward and start the campaign over. Destructive —
   *  callers are expected to confirm first. */
  resetProgress: () => void;
}

const activeLab = (labs: Lab[], id: string): Lab =>
  labs.find((l) => l.id === id) ?? labs[0];

function recompute(labs: Lab[], labId: string, network: NetworkState, history: string[]): ObjectiveResult[] {
  const lab = activeLab(labs, labId);
  return evaluateObjectives(network, lab.objectives, { commandHistory: history });
}

/**
 * Is what's on the canvas graded?
 *
 * Two things on this canvas are not: the free-build sandbox, and a Learn
 * Topology demo. Neither has objectives, so neither can be evaluated, awarded,
 * or gated behind a verifying ping — and both get the "link alive" idle loop
 * after any successful ping, because it is the only lasting feedback they have.
 *
 * A demo has to be named explicitly rather than inferred from its objectives:
 * `activeLabId` still points at whichever lab the student last had open, and
 * evaluating *that* lab's objectives against a topology's network would be
 * meaningless at best and would bank its XP at worst.
 */
function ungraded(s: Pick<AppState, 'topologyMode' | 'labs' | 'activeLabId'>): boolean {
  return s.topologyMode || activeLab(s.labs, s.activeLabId).objectives.length === 0;
}

/** Pick a sensible default shell device (first powered host, else first device). */
function defaultTerminalDevice(network: NetworkState): string | null {
  const host = network.devices.find((d) => ['pc', 'laptop', 'server'].includes(d.kind));
  return host?.id ?? network.devices[0]?.id ?? null;
}

let packetSeq = 0;

export const useStore = create<AppState>((set, get) => {
  const persisted = loadProgress();
  const startLab = activeLab(ALL_LABS, START_LAB_ID);
  const startNetwork = cloneState(startLab.initialState);

  function persist(next: Partial<PersistedProgress>) {
    const s = get();
    const data: PersistedProgress = {
      xp: next.xp ?? s.xp,
      earnedBadges: next.earnedBadges ?? s.earnedBadges,
      unlocked: next.unlocked ?? s.unlocked,
      completedLabs: next.completedLabs ?? s.completedLabs,
      labProgress: next.labProgress ?? s.labProgress,
    };
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify(data));
    } catch {
      /* storage unavailable — progress simply won't persist */
    }
  }

  /**
   * Apply a pure transform to the working network, then re-evaluate objectives
   * and re-gate the lab. Central chokepoint so every mutation stays consistent.
   *
   * `keepIdle` is for the one edit that must not disturb the idle loop — see
   * below.
   */
  function commit(mutator: (net: NetworkState) => void, opts: { keepIdle?: boolean } = {}) {
    const s = get();
    const network = cloneState(s.network);
    mutator(network);

    if (ungraded(s)) {
      // Nothing to grade, so nothing to evaluate. Re-wiring does retire the
      // idle loop though: it is a standing claim that a path works, and the
      // student may have just cut it. Dragging a device is the exception — the
      // loop re-routes onto its new cables, which is the whole trick.
      set({
        network,
        objectiveResults: [],
        ...(opts.keepIdle ? {} : { ambientPath: null }),
      });
      return;
    }

    const objectiveResults = recompute(s.labs, s.activeLabId, network, s.commandHistory);
    set({ network, objectiveResults });
    maybeComplete(objectiveResults);
  }

  /** Bank a lab's rewards and raise the win bar. Called once per lab. */
  function award(lab: Lab) {
    const s = get();
    const xp = s.xp + (lab.rewards.xp ?? 0);
    const earnedBadges = Array.from(new Set([...s.earnedBadges, ...(lab.rewards.badges ?? [])]));
    const unlocked = Array.from(new Set([...s.unlocked, ...(lab.rewards.unlocks ?? [])]));
    const completedLabs = [...s.completedLabs, lab.id];
    const labProgress = {
      ...s.labProgress,
      [lab.id]: { ...s.labProgress[lab.id], [lab.mode]: true },
    };
    set({
      xp,
      earnedBadges,
      unlocked,
      completedLabs,
      labProgress,
      justCompleted: lab.id,
      verifyStatus: 'none',
    });
    persist({ xp, earnedBadges, unlocked, completedLabs, labProgress });
  }

  /**
   * Re-gate the active lab after anything that could have changed its standing.
   *
   * Green objectives used to be the finish line. For a lab that names a verifying
   * ping they are only the halfway mark: the lab parks in `ready` — objectives
   * green, prompt up, no win bar — until the student runs that ping. `verified`
   * is passed by `packetArrived` when the burst lands, and that is the only route
   * to the win bar for such a lab.
   */
  function maybeComplete(objectiveResults: ObjectiveResult[], verified = false) {
    const s = get();
    // A Learn Topology demo can never complete a lab, whatever is on the canvas.
    // Guarded here as well as at every call site: this is the function that
    // hands out XP, and a demo must not be one edit away from banking someone
    // else's mission.
    if (s.topologyMode) return;
    const lab = activeLab(s.labs, s.activeLabId);
    if (lab.objectives.length === 0) return; // sandbox
    if (s.completedLabs.includes(lab.id)) return; // already banked; replaying it

    const status = labStatus(objectiveResults, lab, verified);
    if (status === 'complete') {
      award(lab);
      return;
    }
    if (status === 'awaiting-verification') {
      // An in-flight verification outranks the prompt: an unrelated edit that
      // re-runs the objectives must not knock a running packet back to `ready`.
      if (s.verifyStatus === 'none') set({ verifyStatus: 'ready' });
      return;
    }
    // Something regressed — the prompt (or an in-flight run) no longer applies.
    if (s.verifyStatus !== 'none') set({ verifyStatus: 'none' });
  }

  /**
   * The verifying packets have landed: bank the lab, and if that finished it,
   * leave the proven path pulsing behind the win bar as a quiet "link alive"
   * loop. The one-shot burst is cleared in the same breath so nothing sits
   * frozen on the wire underneath it.
   */
  function settleVerification(path: string[]) {
    maybeComplete(get().objectiveResults, true);
    if (get().justCompleted) set({ ambientPath: path, packet: null });
  }

  /**
   * The canvas as a Learn Topology view leaves it.
   *
   * Four entry points land here — opening the phase, loading a shape, going
   * back to the list, and resetting — and every one of them has to clear the
   * same set of leftovers. Written once so none of them can forget a field, and
   * `objectiveResults` is empty by construction rather than by evaluation: a
   * demo is never graded.
   */
  function topologyCanvas(id: string | null, network: NetworkState, log: TermLine[]) {
    return {
      topologyMode: true,
      topologyId: id,
      network,
      selectedDeviceId: null,
      connectMode: false,
      connectSourceId: null,
      terminalDeviceId: defaultTerminalDevice(network),
      terminalLog: log,
      commandHistory: [],
      packet: null,
      lastResult: null,
      verifyStatus: 'none' as VerifyStatus,
      ambientPath: null,
      justCompleted: null,
      lastDeleted: null,
      objectiveResults: [] as ObjectiveResult[],
    };
  }

  return {
    labs: ALL_LABS,
    activeLabId: START_LAB_ID,
    topologies: TOPOLOGIES,
    topologyMode: false,
    topologyId: null,
    network: startNetwork,
    selectedDeviceId: null,
    objectiveResults: recompute(ALL_LABS, START_LAB_ID, startNetwork, []),

    connectMode: false,
    connectSourceId: null,

    terminalDeviceId: defaultTerminalDevice(startNetwork),
    terminalLog: [
      { text: 'GeekedNet console — type "help" for commands.', cls: 'muted' },
    ],
    commandHistory: [],

    packet: null,
    lastResult: null,
    verifyStatus: 'none',
    ambientPath: null,

    xp: persisted.xp,
    earnedBadges: persisted.earnedBadges,
    unlocked: persisted.unlocked,
    completedLabs: persisted.completedLabs,
    labProgress: persisted.labProgress,
    justCompleted: null,
    resetConfirmOpen: false,
    lastDeleted: null,

    loadLab: (id) => {
      const lab = activeLab(get().labs, id);
      const network = cloneState(lab.initialState);
      set({
        activeLabId: lab.id,
        // Opening a lab leaves Learn Topology: the two share one canvas, and a
        // graded mission must never be evaluated against a demo's network.
        topologyMode: false,
        topologyId: null,
        network,
        selectedDeviceId: null,
        connectMode: false,
        connectSourceId: null,
        terminalDeviceId: defaultTerminalDevice(network),
        terminalLog: [
          { text: `# ${lab.title} — ${lab.mode.toUpperCase()} (tier ${lab.tier})`, cls: 'muted' },
          { text: 'Type "help" for commands.', cls: 'muted' },
        ],
        commandHistory: [],
        packet: null,
        lastResult: null,
        verifyStatus: 'none',
        ambientPath: null,
        justCompleted: null,
        // The pieces belong to the canvas being left behind — restoring them
        // into a different lab would drop a stranger into the topology.
        lastDeleted: null,
        objectiveResults: recompute(get().labs, lab.id, network, []),
      });
    },

    resetLab: () => {
      const s = get();
      const lab = activeLab(s.labs, s.activeLabId);
      const network = cloneState(lab.initialState);
      set({
        network,
        selectedDeviceId: null,
        connectMode: false,
        connectSourceId: null,
        terminalDeviceId: defaultTerminalDevice(network),
        packet: null,
        lastResult: null,
        verifyStatus: 'none',
        ambientPath: null,
        lastDeleted: null,
        objectiveResults: recompute(s.labs, lab.id, network, s.commandHistory),
      });
    },

    enterTopologyMode: () => {
      set(
        topologyCanvas(null, { devices: [], links: [] }, [
          { text: '# Learn Topology — pick a shape to load it, fully built.', cls: 'muted' },
          { text: 'Demos, not labs: nothing here is scored.', cls: 'muted' },
        ]),
      );
    },

    /**
     * Put a shape on the canvas exactly as its data describes it — devices
     * placed, cables run, addresses assigned — so the next thing the student
     * does can be a ping.
     *
     * The suggested ping is derived from the network rather than authored, so a
     * new topology arrives with one for free. See `demoPing`.
     */
    loadTopology: (id) => {
      const demo = getTopology(id);
      if (!demo) return;
      const network = cloneState(demo.initialState);
      const suggestion = demoPing(network);
      const log: TermLine[] = [
        { text: `# Learn Topology — ${demo.name} (demo · nothing to score)`, cls: 'muted' },
      ];
      if (suggestion) {
        log.push({
          text: `# ${suggestion.from.label} is ready — try: ping ${suggestion.toIp}`,
          cls: 'muted',
        });
      }
      set(topologyCanvas(demo.id, network, log));
    },

    backToTopologies: () => get().enterTopologyMode(),

    resetTopology: () => {
      const demo = getTopology(get().topologyId);
      if (demo) get().loadTopology(demo.id);
    },

    selectDevice: (id) => set({ selectedDeviceId: id }),

    addDevice: (kind, x, y) => {
      const s = get();
      const count = s.network.devices.filter((d) => d.kind === kind).length;
      const labelBase = kind === 'pc' ? 'PC' : kind === 'switch' ? 'SW' : 'R';
      const device = makeDevice(kind, x, y, `${labelBase}${count + 1}`);
      commit((net) => {
        net.devices.push(device);
      });
      set({
        selectedDeviceId: device.id,
        terminalDeviceId: get().terminalDeviceId ?? defaultTerminalDevice(get().network),
      });
    },

    moveDevice: (id, x, y) => {
      commit(
        (net) => {
          const d = net.devices.find((dev) => dev.id === id);
          if (d) {
            d.x = x;
            d.y = y;
          }
        },
        // Moving a device changes where the cables are drawn, not which cables
        // exist — the idle loop follows it rather than being retired by it.
        { keepIdle: true },
      );
    },

    removeDevice: (id) => {
      // Captured inside the mutator, off the working copy, before the device and
      // its cables are filtered out of it.
      let snapshot: DeletedDevice | null = null;
      commit((net) => {
        const dev = net.devices.find((d) => d.id === id);
        if (!dev) return;
        const linkIds = new Set(
          dev.interfaces.map((i) => i.linkId).filter((v): v is string => !!v),
        );
        snapshot = {
          device: structuredClone(dev),
          links: structuredClone(net.links.filter((l) => linkIds.has(l.id))),
          label: dev.label,
        };
        net.links = net.links.filter((l) => !linkIds.has(l.id));
        // Clear the dangling linkId on the far side of each removed link.
        for (const other of net.devices) {
          for (const iface of other.interfaces) {
            if (iface.linkId && linkIds.has(iface.linkId)) iface.linkId = null;
          }
        }
        net.devices = net.devices.filter((d) => d.id !== id);
      });
      const s = get();
      set({
        selectedDeviceId: s.selectedDeviceId === id ? null : s.selectedDeviceId,
        terminalDeviceId:
          s.terminalDeviceId === id ? defaultTerminalDevice(s.network) : s.terminalDeviceId,
        // Only offer an undo for a deletion that happened. Asking to remove a
        // device that is already gone leaves the previous offer standing.
        lastDeleted: snapshot ?? s.lastDeleted,
      });
    },

    /**
     * Put the device and its cables back.
     *
     * A cable only returns if both of its ports are still free: the student may
     * have re-used one since, and quietly stealing it back would break a link
     * they built on purpose. Any port whose cable cannot return is left
     * unplugged rather than pointing at a link that no longer exists.
     */
    undoDelete: () => {
      const snapshot = get().lastDeleted;
      if (!snapshot) return;
      commit((net) => {
        if (net.devices.some((d) => d.id === snapshot.device.id)) return;
        const restored = structuredClone(snapshot.device);
        net.devices.push(restored);

        for (const link of snapshot.links) {
          const a = net.devices.find((d) => d.id === link.a.deviceId);
          const b = net.devices.find((d) => d.id === link.b.deviceId);
          const ifaceA = a?.interfaces.find((i) => i.id === link.a.ifaceId);
          const ifaceB = b?.interfaces.find((i) => i.id === link.b.ifaceId);
          if (!ifaceA || !ifaceB) continue; // an endpoint is gone too
          if (ifaceA.linkId && ifaceA.linkId !== link.id) continue; // port re-used
          if (ifaceB.linkId && ifaceB.linkId !== link.id) continue;
          if (net.links.some((l) => l.id === link.id)) continue;
          ifaceA.linkId = link.id;
          ifaceB.linkId = link.id;
          net.links.push(structuredClone(link));
        }

        for (const iface of restored.interfaces) {
          if (iface.linkId && !net.links.some((l) => l.id === iface.linkId)) iface.linkId = null;
        }
      });
      set({ lastDeleted: null, selectedDeviceId: snapshot.device.id });
    },

    dismissUndo: () => set({ lastDeleted: null }),

    setPower: (id, powered) => {
      commit((net) => {
        const d = net.devices.find((dev) => dev.id === id);
        if (d) d.powered = powered;
      });
    },

    setIfaceField: (deviceId, ifaceId, field, value) => {
      const clean = value.trim();
      commit((net) => {
        const d = net.devices.find((dev) => dev.id === deviceId);
        const iface = d?.interfaces.find((i) => i.id === ifaceId);
        if (iface) iface[field] = clean === '' ? null : clean;
      });
    },

    setGateway: (deviceId, gateway) => {
      const clean = gateway.trim();
      commit((net) => {
        const d = net.devices.find((dev) => dev.id === deviceId);
        if (d) d.gateway = clean === '' ? undefined : clean;
      });
    },

    addRoute: (deviceId) => {
      commit((net) => {
        const d = net.devices.find((dev) => dev.id === deviceId);
        if (!d) return;
        if (!d.routes) d.routes = [];
        d.routes.push({ dst: '', mask: '255.255.255.0', gateway: '' });
      });
    },

    updateRoute: (deviceId, index, field, value) => {
      commit((net) => {
        const d = net.devices.find((dev) => dev.id === deviceId);
        const route = d?.routes?.[index];
        if (route) route[field] = value.trim();
      });
    },

    removeRoute: (deviceId, index) => {
      commit((net) => {
        const d = net.devices.find((dev) => dev.id === deviceId);
        if (d?.routes) d.routes.splice(index, 1);
      });
    },

    toggleConnectMode: () => {
      const s = get();
      set({ connectMode: !s.connectMode, connectSourceId: null });
    },

    clickDeviceForConnect: (id) => {
      const s = get();
      if (!s.connectSourceId) {
        set({ connectSourceId: id });
        return;
      }
      if (s.connectSourceId === id) {
        set({ connectSourceId: null });
        return;
      }
      const sourceId = s.connectSourceId;
      const linkId = nextId('l');
      let failed: string | null = null;
      commit((net) => {
        const a = net.devices.find((d) => d.id === sourceId);
        const b = net.devices.find((d) => d.id === id);
        if (!a || !b) {
          failed = 'device not found';
          return;
        }
        const freeA = firstFreeIface(a);
        const freeB = firstFreeIface(b);
        if (!freeA) {
          failed = `${a.label} has no free port`;
          return;
        }
        if (!freeB) {
          failed = `${b.label} has no free port`;
          return;
        }
        freeA.linkId = linkId;
        freeB.linkId = linkId;
        net.links.push({
          id: linkId,
          a: { deviceId: a.id, ifaceId: freeA.id },
          b: { deviceId: b.id, ifaceId: freeB.id },
        });
      });
      set({ connectSourceId: null });
      if (failed) {
        set({
          lastResult: { success: false, path: [], reason: failed },
        });
      }
    },

    removeLink: (linkId) => {
      commit((net) => {
        net.links = net.links.filter((l) => l.id !== linkId);
        for (const d of net.devices) {
          for (const iface of d.interfaces) {
            if (iface.linkId === linkId) iface.linkId = null;
          }
        }
      });
    },

    runTerminal: (raw) => {
      const s = get();
      const deviceId = s.terminalDeviceId ?? defaultTerminalDevice(s.network);
      const lab = activeLab(s.labs, s.activeLabId);
      const dev = deviceId ? getDevice(s.network, deviceId) : undefined;
      const promptLabel = dev ? `${dev.label.toLowerCase()}@geekednet:~$` : 'guest@geekednet:~$';

      if (!deviceId) {
        set({
          terminalLog: [
            ...s.terminalLog,
            { text: `${promptLabel} ${raw}`, cls: 'prompt' },
            { text: 'no device on the canvas — add one first', cls: 'err' },
          ],
        });
        return;
      }

      // No lab behind a demo: its shell gets the plain engine, not the scripted
      // outputs of whichever mission the student last had open.
      const result = runCommand(s.network, deviceId, raw, s.topologyMode ? undefined : lab);
      if (result.clear) {
        set({ terminalLog: [] });
        return;
      }

      const echoed: TermLine[] = [{ text: `${promptLabel} ${raw}`, cls: 'prompt' }, ...result.lines];
      const commandHistory = result.command
        ? [...s.commandHistory, result.command]
        : s.commandHistory;

      set({
        terminalLog: [...s.terminalLog, ...echoed],
        commandHistory,
      });

      // Re-evaluate objectives that depend on command history (fidelity B).
      const objectiveResults = ungraded(s)
        ? []
        : recompute(s.labs, s.activeLabId, s.network, commandHistory);
      set({ objectiveResults });

      // Is this the ping the lab is signed off with? Only if the lab names this
      // exact run, every objective is already green, and the packet actually got
      // through. A ping run too early — or one that fails — is just a ping.
      const target: string | undefined = result.command.split(' ')[1];
      const verifying =
        !ungraded(s) &&
        !!result.sim?.success &&
        result.command.startsWith('ping ') &&
        !!target &&
        !s.completedLabs.includes(lab.id) &&
        isVerifyPing(lab, deviceId, target, s.network) &&
        labStatus(objectiveResults, lab, true) === 'complete';

      // The win bar no longer rises from here. `packetArrived` finishes the job
      // once the verifying burst has actually reached the far end.
      if (verifying) set({ verifyStatus: 'verifying' });
      else if (!ungraded(s)) maybeComplete(objectiveResults);

      if (result.sim) get().animatePath(result.sim, target, verifying);
    },

    clearTerminal: () => set({ terminalLog: [] }),

    animatePath: (result, target, verify = false) => {
      packetSeq += 1;
      set({
        packet: {
          id: packetSeq,
          path: result.path,
          success: result.success,
          verify,
          // Only a broadcast fans out. Everything else keeps the single run it
          // has always had, down to the same field being absent.
          recipients: result.broadcast ? result.recipients : undefined,
        },
        lastResult: { ...result, target },
        // In an ungraded space the idle loop *is* the last ping's result, so a
        // new run takes the old loop down rather than flying over it. It comes
        // back — on the new path — when this one lands. In a lab the loop
        // belongs to the completed mission and outlasts any later ping.
        ...(ungraded(get()) ? { ambientPath: null } : {}),
      });
    },

    /**
     * A packet finished its run.
     *
     * For a lab's verifying burst that means banking the lab and handing the
     * path to the ambient loop; the burst itself is cleared so a frozen packet
     * doesn't sit under the slow pulse that replaces it.
     *
     * For the sandbox and the topology demos there is no lab to bank — but the
     * loop is exactly what they were missing. A free build gets the same "link
     * alive" pulse a finished mission gets, on the path the ping just proved.
     * A run that failed leaves nothing pulsing: there is no live path to show.
     */
    packetArrived: (packetId) => {
      const s = get();
      if (s.packet?.id !== packetId) return; // a newer run superseded this one
      if (s.verifyStatus === 'verifying') {
        settleVerification(s.packet.path);
        return;
      }
      if (!ungraded(s)) return;
      if (s.packet.success && s.packet.path.length > 1) {
        set({ ambientPath: s.packet.path, packet: null });
      } else {
        set({ ambientPath: null });
      }
    },

    dismissResult: () => {
      const s = get();
      // Dismissing the banner pulls the packet off the canvas mid-flight. If that
      // was the verifying run, settle the lab now rather than stranding it — and
      // in an ungraded space a successful run still earns its idle loop, which
      // the student would otherwise lose by tidying the banner away.
      if (s.verifyStatus === 'verifying' && s.packet) settleVerification(s.packet.path);
      else if (ungraded(s) && s.packet?.success && s.packet.path.length > 1) {
        set({ ambientPath: s.packet.path });
      }
      set({ lastResult: null, packet: null });
    },
    // Dismissing the bar ends the moment entirely, ambient loop included.
    dismissCompletion: () => set({ justCompleted: null, ambientPath: null }),
    setResetConfirm: (open) => set({ resetConfirmOpen: open }),

    resetProgress: () => {
      try {
        localStorage.removeItem(PERSIST_KEY);
      } catch {
        /* storage unavailable — the in-memory reset below still stands */
      }
      // Rewards first, then loadLab: loading clears the canvas, the terminal and
      // justCompleted, so the player lands on lab one with nothing carried over.
      set(defaultProgress());
      get().loadLab(START_LAB_ID);
    },
  };
});

function firstFreeIface(device: Device): Interface | undefined {
  return device.interfaces.find((i) => !i.linkId);
}
