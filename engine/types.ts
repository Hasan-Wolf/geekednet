/**
 * GeekedNet core data model (Build Brief §6).
 *
 * Everything in the platform — a beginner's first ping and a master-level OSPF
 * lab — is the same thing: a graph of devices (nodes) and links (edges), where
 * each device carries config state. The engine never hard-codes a lesson; a lab
 * is pure data (see {@link Lab}).
 *
 * Note on `ip` / `mask`: the lab JSON uses `null` for an unconfigured field, so
 * these are typed `string | null | undefined`. Engine code treats `null` and
 * `undefined` identically ("no value"); use a truthy check, never `!== undefined`.
 */

export type DeviceKind =
  | 'pc'
  | 'laptop'
  | 'switch'
  | 'hub'
  | 'router'
  | 'server'
  | 'firewall'
  | 'ap'
  | 'cloud'
  | 'attacker';

export interface Interface {
  id: string;
  name: string;
  ip?: string | null;
  mask?: string | null;
  linkId?: string | null;
  /**
   * Physical-layer settings, for labs that teach physical-layer faults.
   *
   * Both are optional and both are only ever compared against the far end of the
   * cable: a link where one side states a value and the other does not is taken
   * as auto-negotiated, not as a mismatch. A lab that does not care about layer 1
   * omits them entirely and nothing changes. See `interfaceLinkStatus`.
   */
  speed?: number; // Mbit/s
  duplex?: 'half' | 'full';
}

export interface RouteEntry {
  dst: string;
  mask: string;
  gateway: string;
}

export interface FirewallRule {
  action: 'pass' | 'block';
  srcZone?: string;
  dstZone?: string;
  proto?: 'any' | 'icmp' | 'tcp' | 'udp';
  ports?: number[];
}

export interface Device {
  id: string;
  kind: DeviceKind;
  label: string;
  interfaces: Interface[];
  gateway?: string; // default gateway (hosts)
  routes?: RouteEntry[]; // routers
  services?: {
    dhcp?: { enabled: boolean; pool?: [string, string] };
    dns?: { enabled: boolean; records?: Record<string, string> };
    nat?: { enabled: boolean };
  };
  firewall?: FirewallRule[];
  zone?: string; // for firewall labs
  powered: boolean;
  x: number;
  y: number;
}

export interface Link {
  id: string;
  a: { deviceId: string; ifaceId: string };
  b: { deviceId: string; ifaceId: string };
}

export interface NetworkState {
  devices: Device[];
  links: Link[];
}

/** Result of a single-direction packet simulation (Build Brief §7). */
export interface SimResult {
  success: boolean;
  /**
   * The hops the packet took, sender first.
   *
   * For a broadcast this is the run to the *nearest* device that accepted it —
   * one real leg out of several, because a single ordered list cannot describe a
   * frame that fanned out. {@link SimResult.recipients} is the full truth, and
   * anything drawing a broadcast to every destination at once needs to read that
   * instead of this.
   */
  path: string[];
  /** Human-readable failure explanation. Feeds hints and the companion bot. */
  reason?: string;
  /**
   * This delivery was a broadcast — one frame accepted by every host on the
   * segment — rather than a unicast to one owner of the address.
   */
  broadcast?: boolean;
  /**
   * Every device that accepted the broadcast, nearest first. Set only when
   * `broadcast` is. `simulatePacket` reports who *received* the frame; `ping`
   * narrows it to those that could also send a reply back.
   */
  recipients?: string[];
}

// --- Lab / content schema (Build Brief §6) --------------------------------

export type Predicate =
  // Exactly one of `toIp` / `toDevice` — enforced by `validatePredicate`, since
  // JSON never meets the type system. `toDevice` names the destination *host*
  // and its address is resolved from live state at check time, which is what a
  // lab needs when the student picks that address themselves.
  | { type: 'canPing'; from: string; toIp?: string; toDevice?: string }
  | { type: 'ifaceHasIp'; device: string; iface: string; ip: string; mask?: string }
  // The open-ended sibling of `ifaceHasIp`: the lab names the network, the
  // student names the host. Passes when the interface carries `mask` exactly and
  // an address that is inside `network`/`mask`, is a usable host address (not the
  // network or broadcast address), and is not already taken by another interface.
  | { type: 'ifaceInNetwork'; device: string; iface: string; network: string; mask: string }
  // `mask` is required: a route's destination is a network, and 20.0.0.0/24 is
  // not 20.0.0.0/8. Leaving it off would let a wrong prefix satisfy the objective.
  | { type: 'hasRoute'; device: string; dst: string; mask: string; gateway: string }
  | { type: 'commandRun'; matches: string } // fidelity B: regex on entered command
  | { type: 'answerEquals'; key: string; value: string }; // student-submitted answer

export interface Objective {
  id: string;
  description: string;
  check: Predicate;
}

export interface Hint {
  level: 1 | 2 | 3;
  text: string;
}

/**
 * The ping a lab is signed off with (Build Brief §11 — "make them talk").
 *
 * Green objectives say the config *looks* right. This says the student watched a
 * packet make the trip. A lab that declares a verifying ping is not complete the
 * moment its objectives evaluate true: it parks with everything green until this
 * exact ping — this source device, this destination address — has been run from
 * the terminal and succeeded. A lab that declares none completes on objectives
 * alone, which is the original behaviour.
 */
export interface VerifyPing {
  /** Device id the ping must be run from (the terminal's active device). */
  from: string;
  /**
   * Destination address the ping must target, when the lab pins one.
   * Exactly one of `toIp` / `toDevice` — enforced by `validateLab`.
   */
  toIp?: string;
  /**
   * Destination *device*, resolved to whatever address it currently carries.
   *
   * A lab that lets the student choose the target's address cannot name that
   * address up front, and a literal one baked in here would only ever match the
   * address the author happened to imagine. Naming the device keeps the sign-off
   * run honest: it is always "ping the machine at the other end", whatever the
   * student put on it. See `verifyTargetIp`.
   */
  toDevice?: string;
  /** Overrides the default "now prove it" line shown to the student. */
  prompt?: string;
}

export interface Lab {
  id: string; // "tier0-first-ping.learn"
  tier: 0 | 1 | 2 | 3 | 4 | 5;
  mode: 'learn' | 'practice' | 'master';
  fidelity: 'A' | 'B';
  title: string;
  brief: string; // the scenario / story
  initialState: NetworkState; // often deliberately broken
  objectives: Objective[];
  /** Optional sign-off ping. Omit it and the lab completes on objectives alone. */
  verify?: VerifyPing;
  hints: Hint[]; // nudge -> guide -> near-answer
  botOpeners?: string[]; // proactive lines the bot may say (learn mode)
  rewards: { xp: number; badges?: string[]; unlocks?: string[] };
  allowedCommands?: string[]; // fidelity B terminals
  scriptedOutputs?: Record<string, string>; // command (or regex key) -> canned output
}

/**
 * Optional context supplied when evaluating objectives whose predicates depend
 * on things outside {@link NetworkState}: fidelity-B terminal history and
 * student-submitted answers. Not needed for the three MVP missions (which use
 * only `ifaceHasIp`, `hasRoute`, and `canPing`).
 */
export interface EvalContext {
  commandHistory?: string[];
  answers?: Record<string, string>;
}
