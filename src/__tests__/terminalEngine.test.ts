/**
 * Console formatting for deliveries that are not a plain unicast.
 *
 * The engine now distinguishes a broadcast from a unicast; the console has to
 * say so too, or the student reads "reply from 192.168.1.255" and learns that
 * the broadcast address is a machine.
 */
import { describe, it, expect } from 'vitest';
import type { NetworkState } from '../../engine/index.js';
import { runCommand } from '../terminalEngine.js';

/** PC1, PC2 and PC3 on one switch, all /24. */
function segment(): NetworkState {
  const host = (id: string, label: string, ip: string, linkId: string) => ({
    id,
    kind: 'pc' as const,
    label,
    powered: true,
    x: 0,
    y: 0,
    interfaces: [{ id: 'e0', name: 'eth0', ip, mask: '255.255.255.0', linkId }],
  });
  return {
    devices: [
      host('pc1', 'PC1', '192.168.1.10', 'l1'),
      host('pc2', 'PC2', '192.168.1.11', 'l2'),
      host('pc3', 'PC3', '192.168.1.12', 'l3'),
      {
        id: 'sw',
        kind: 'switch',
        label: 'Switch',
        powered: true,
        x: 0,
        y: 0,
        interfaces: [
          { id: 'p1', name: 'port1', linkId: 'l1' },
          { id: 'p2', name: 'port2', linkId: 'l2' },
          { id: 'p3', name: 'port3', linkId: 'l3' },
        ],
      },
    ],
    links: [
      { id: 'l1', a: { deviceId: 'pc1', ifaceId: 'e0' }, b: { deviceId: 'sw', ifaceId: 'p1' } },
      { id: 'l2', a: { deviceId: 'pc2', ifaceId: 'e0' }, b: { deviceId: 'sw', ifaceId: 'p2' } },
      { id: 'l3', a: { deviceId: 'pc3', ifaceId: 'e0' }, b: { deviceId: 'sw', ifaceId: 'p3' } },
    ],
  };
}

const textOf = (result: { lines: { text: string }[] }) => result.lines.map((l) => l.text).join('\n');

describe('ping output — broadcast', () => {
  it('names each host that answered, not the broadcast address', () => {
    const out = textOf(runCommand(segment(), 'pc1', 'ping 192.168.1.255'));
    expect(out).toContain('PING 192.168.1.255 (broadcast)');
    expect(out).toContain('reply from 192.168.1.11:');
    expect(out).toContain('reply from 192.168.1.12:');
    expect(out).not.toContain('reply from 192.168.1.255');
  });

  it('flags the extra answers as duplicates, the way ping -b does', () => {
    const out = textOf(runCommand(segment(), 'pc1', 'ping 192.168.1.255'));
    expect(out).toContain('(DUP!)');
    expect(out).toContain('3 packets transmitted, 6 received, +3 duplicates, 0% packet loss');
  });

  it('leaves an ordinary unicast ping exactly as it was', () => {
    const out = textOf(runCommand(segment(), 'pc1', 'ping 192.168.1.11'));
    expect(out).toContain('PING 192.168.1.11');
    expect(out).not.toContain('(broadcast)');
    expect(out).not.toContain('(DUP!)');
    expect(out).toContain('3 packets transmitted, 3 received, 0% packet loss');
  });

  it('reports the engine reason when the destination is a network address', () => {
    const out = textOf(runCommand(segment(), 'pc1', 'ping 192.168.1.0'));
    expect(out).toContain('names the network itself, not a host on it');
    expect(out).toContain('100% packet loss');
  });
});
