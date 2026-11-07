export const PACKET_PULSE_COUNT = 6;
export const PACKET_FLIGHT_MS = 1150;
export const PACKET_STAGGER_MS = 100;
export const PACKET_LOOP_MS = 1500;
export const PACKET_DIAMETER_PX = 5.5;
export const PACKET_BURST_MS = PACKET_FLIGHT_MS + (PACKET_PULSE_COUNT - 1) * PACKET_STAGGER_MS;

/** Shared distance keeps a broadcast together until its real cable branches. */
export function packetPulses(elapsed: number, longestRun: number, loop: boolean) {
  if (longestRun <= 0 || elapsed < 0) return [];
  const pulses: Array<{ index: number; color: 0 | 1; distance: number }> = [];
  for (let index = 0; index < PACKET_PULSE_COUNT; index++) {
    const phase = loop
      ? ((elapsed / PACKET_LOOP_MS - index / PACKET_PULSE_COUNT) % 1 + 1) % 1
      : (elapsed - index * PACKET_STAGGER_MS) / PACKET_FLIGHT_MS;
    if (phase < 0 || phase > 1) continue;
    pulses.push({ index, color: index % 2 as 0 | 1, distance: phase * longestRun });
  }
  return pulses;
}
