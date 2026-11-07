import { describe, expect, it } from 'vitest';
import { PACKET_BURST_MS, PACKET_FLIGHT_MS, PACKET_LOOP_MS, PACKET_PULSE_COUNT, packetPulses } from '../labPackets.js';

describe('visible blue and green packet streams', () => {
  it('keeps six differently spaced pulses with three of each color in the live stream', () => {
    const pulses = packetPulses(250, 120, true);
    expect(pulses).toHaveLength(6);
    expect(pulses.filter(p => p.color === 0)).toHaveLength(3);
    expect(pulses.filter(p => p.color === 1)).toHaveLength(3);
    const distances = pulses.map(p => p.distance).sort((a, b) => a - b);
    for (let i = 1; i < distances.length; i++) expect(distances[i] - distances[i - 1]).toBeCloseTo(20);
  });
  it('moves smoothly and repeats without accumulating dots at the destination', () => {
    const initial = packetPulses(200, 100, true);
    const later = packetPulses(300, 100, true);
    expect(later[0].distance).toBeGreaterThan(initial[0].distance);
    const repeated = packetPulses(200 + PACKET_LOOP_MS, 100, true);
    repeated.forEach((pulse, i) => expect(pulse.distance).toBeCloseTo(initial[i].distance));
  });
  it('launches a staggered burst instead of stacking all six dots at the source', () => {
    expect(packetPulses(0, 100, false)).toHaveLength(1);
    const pulses = packetPulses(550, 100, false);
    expect(pulses).toHaveLength(PACKET_PULSE_COUNT);
    for (let i = 1; i < pulses.length; i++) expect(pulses[i].distance).toBeLessThan(pulses[i - 1].distance);
  });
  it('waits for the last pulse before completing the burst', () => {
    const last = packetPulses(PACKET_BURST_MS, 100, false);
    expect(last).toHaveLength(1); expect(last[0].index).toBe(5); expect(last[0].distance).toBeCloseTo(100);
    expect(PACKET_BURST_MS).toBeGreaterThan(PACKET_FLIGHT_MS);
  });
  it('does not keep a failed finite burst moving after it has finished', () => {
    expect(packetPulses(PACKET_BURST_MS + 50, 100, false)).toEqual([]);
  });
  it('never invents traffic when there is no route or the burst has not started', () => {
    expect(packetPulses(500, 0, true)).toEqual([]);
    expect(packetPulses(-1, 100, false)).toEqual([]);
  });
  it('keeps long-running streams on the real length of the route', () => {
    for (const elapsed of [0, 10000, 100000000]) {
      const pulses = packetPulses(elapsed, 75, true); expect(pulses).toHaveLength(6);
      for (const pulse of pulses) { expect(pulse.distance).toBeGreaterThanOrEqual(0); expect(pulse.distance).toBeLessThan(75); }
    }
  });
});
