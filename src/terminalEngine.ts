/**
 * Minimal, forgiving shell (Build Brief §11 "Terminal (minimal): ping, ip addr").
 *
 * This layer is pure UI glue: it parses a typed line, calls the engine's own
 * `ping` / `simulatePacket`, and formats the result the way a real console would.
 * It never mutates network state and contains no lesson logic — fidelity-B labs
 * plug in through `lab.scriptedOutputs` / `lab.allowedCommands` (data), so the
 * flagship "nmap -sn" stub works with zero engine or parser changes.
 */
import {
  deviceIp,
  getDevice,
  maskToPrefix,
  ping,
  simulatePacket,
  type Lab,
  type NetworkState,
  type SimResult,
} from '../engine/index.js';

export type LineClass = 'prompt' | 'ok' | 'err' | 'muted' | 'plain';
export interface TermLine {
  text: string;
  cls?: LineClass;
}

export interface CommandResult {
  lines: TermLine[];
  /** Set when the command produced a packet path worth animating on the canvas. */
  sim?: SimResult;
  /** The normalized command string, recorded for `commandRun` objective checks. */
  command: string;
  clear?: boolean;
}

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;

function usage(cmd: string): TermLine[] {
  const help: Record<string, string> = {
    ping: 'usage: ping <ip>',
    traceroute: 'usage: traceroute <ip>',
  };
  return [{ text: help[cmd] ?? `unknown command: ${cmd}`, cls: 'err' }];
}

const HELP_LINES: TermLine[] = [
  { text: 'available commands:', cls: 'muted' },
  { text: '  ping <ip>        send ICMP echo to a host', cls: 'plain' },
  { text: '  traceroute <ip>  show the path to a host', cls: 'plain' },
  { text: '  ip addr          show this device’s interfaces (alias: ip a, ifconfig)', cls: 'plain' },
  { text: '  clear            clear the screen', cls: 'plain' },
  { text: '  help             show this list', cls: 'plain' },
];

/** Interfaces of the device that is running the shell. */
function ipAddr(state: NetworkState, deviceId: string): TermLine[] {
  const dev = getDevice(state, deviceId);
  if (!dev) return [{ text: 'no such device', cls: 'err' }];
  const lines: TermLine[] = [];
  dev.interfaces.forEach((iface, idx) => {
    const up = iface.linkId ? 'UP' : 'DOWN';
    lines.push({
      text: `${idx + 1}: ${iface.name}: <${up}> ${dev.powered ? '' : '(powered off) '}`.trimEnd(),
      cls: 'plain',
    });
    if (iface.ip && iface.mask) {
      let prefix = '';
      try {
        prefix = `/${maskToPrefix(iface.mask)}`;
      } catch {
        prefix = '';
      }
      lines.push({ text: `    inet ${iface.ip}${prefix}  netmask ${iface.mask}`, cls: 'muted' });
    } else {
      lines.push({ text: '    inet (unconfigured)', cls: 'muted' });
    }
  });
  if (dev.gateway) lines.push({ text: `default via ${dev.gateway}`, cls: 'muted' });
  return lines;
}

/** One reply line per responder per sequence, the extras flagged the way a real
 *  `ping -b` flags them. A broadcast that two hosts answered has to *look* like
 *  two hosts answering, or the console quietly contradicts the engine. */
function broadcastReplies(state: NetworkState, recipients: string[]): TermLine[] {
  const addrs = recipients.map(
    (id) => deviceIp(state, id) ?? getDevice(state, id)?.label ?? id,
  );
  const lines: TermLine[] = [];
  for (let seq = 1; seq <= 3; seq += 1) {
    addrs.forEach((addr, i) => {
      const t = (1 + Math.random() * 2).toFixed(1);
      lines.push({
        text: `reply from ${addr}: icmp_seq=${seq} ttl=64 time=${t}ms${i > 0 ? ' (DUP!)' : ''}`,
        cls: 'ok',
      });
    });
  }
  return lines;
}

function doPing(state: NetworkState, deviceId: string, target: string): CommandResult {
  const command = `ping ${target}`;
  const result = ping(state, deviceId, target);
  const lines: TermLine[] = [
    { text: result.broadcast ? `PING ${target} (broadcast)` : `PING ${target}`, cls: 'muted' },
  ];

  if (result.success && result.broadcast) {
    const replies = broadcastReplies(state, result.recipients ?? []);
    const dups = replies.length - 3;
    lines.push(...replies);
    lines.push({ text: `--- ${target} ping statistics ---`, cls: 'muted' });
    lines.push({
      text:
        `3 packets transmitted, ${replies.length} received` +
        `${dups > 0 ? `, +${dups} duplicates` : ''}, 0% packet loss`,
      cls: 'ok',
    });
    return { lines, sim: result, command };
  }

  if (result.success) {
    for (let i = 0; i < 3; i++) {
      const t = (1 + Math.random() * 2).toFixed(1);
      lines.push({ text: `reply from ${target}: icmp_seq=${i + 1} ttl=64 time=${t}ms`, cls: 'ok' });
    }
    lines.push({ text: `--- ${target} ping statistics ---`, cls: 'muted' });
    lines.push({ text: '3 packets transmitted, 3 received, 0% packet loss', cls: 'ok' });
  } else {
    lines.push({ text: `request failed: ${result.reason ?? 'destination unreachable'}`, cls: 'err' });
    lines.push({ text: `--- ${target} ping statistics ---`, cls: 'muted' });
    lines.push({ text: '3 packets transmitted, 0 received, 100% packet loss', cls: 'err' });
  }
  return { lines, sim: result, command };
}

function doTraceroute(state: NetworkState, deviceId: string, target: string): CommandResult {
  const command = `traceroute ${target}`;
  const result = simulatePacket(state, deviceId, target);
  const lines: TermLine[] = [{ text: `traceroute to ${target}`, cls: 'muted' }];
  result.path.forEach((hopId, i) => {
    const dev = getDevice(state, hopId);
    lines.push({ text: `${i + 1}  ${dev?.label ?? hopId}`, cls: 'plain' });
  });
  if (!result.success) {
    lines.push({ text: `  * path incomplete: ${result.reason ?? 'unreachable'}`, cls: 'err' });
  }
  return { lines, sim: result, command };
}

/** Try lab-authored scripted output (fidelity B). Exact key or regex key. */
function scripted(lab: Lab | undefined, raw: string): TermLine[] | undefined {
  const table = lab?.scriptedOutputs;
  if (!table) return undefined;
  if (table[raw] !== undefined) return splitOutput(table[raw]);
  for (const [key, value] of Object.entries(table)) {
    try {
      if (new RegExp(key).test(raw)) return splitOutput(value);
    } catch {
      /* not a valid regex — treat as literal, already checked above */
    }
  }
  return undefined;
}

function splitOutput(value: string): TermLine[] {
  return value.split('\n').map((text) => ({ text, cls: 'plain' as LineClass }));
}

/**
 * Parse and execute one typed line. Forgiving: trims, collapses whitespace, and
 * lower-cases the command word (arguments such as IPs keep their case).
 */
export function runCommand(
  state: NetworkState,
  deviceId: string,
  raw: string,
  lab?: Lab,
): CommandResult {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (trimmed === '') return { lines: [], command: '' };

  const parts = trimmed.split(' ');
  const cmd = parts[0].toLowerCase();
  const arg = parts[1];

  // Lab-authored scripted commands win first (recon tools, etc.).
  const canned = scripted(lab, trimmed);
  if (canned) return { lines: canned, command: trimmed };

  switch (cmd) {
    case 'clear':
    case 'cls':
      return { lines: [], command: trimmed, clear: true };

    case 'help':
    case '?':
      return { lines: HELP_LINES, command: trimmed };

    case 'ip': {
      const sub = (parts[1] ?? '').toLowerCase();
      if (sub === 'addr' || sub === 'a' || sub === 'address') {
        return { lines: ipAddr(state, deviceId), command: trimmed };
      }
      return { lines: [{ text: 'usage: ip addr', cls: 'err' }], command: trimmed };
    }
    case 'ifconfig':
      return { lines: ipAddr(state, deviceId), command: trimmed };

    case 'ping':
      if (!arg || !IPV4.test(arg)) return { lines: usage('ping'), command: trimmed };
      return doPing(state, deviceId, arg);

    case 'traceroute':
    case 'tracert':
      if (!arg || !IPV4.test(arg)) return { lines: usage('traceroute'), command: trimmed };
      return doTraceroute(state, deviceId, arg);

    default:
      return {
        lines: [{ text: `command not found: ${cmd} (try 'help')`, cls: 'err' }],
        command: trimmed,
      };
  }
}
