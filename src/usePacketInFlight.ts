import { useRef } from 'react';
import { useStore } from './store.js';

/** Finished packets may remain in the store so their result can still be drawn. */
export function usePacketInFlight() {
  const id = useStore(s => s.packet?.id);
  const landed = useStore(s => s.packetsLanded);
  const flight = useRef({ id, landed });
  if (flight.current.id !== id) flight.current = { id, landed };
  return id !== undefined && landed === flight.current.landed;
}
