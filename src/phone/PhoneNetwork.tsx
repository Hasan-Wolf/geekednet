import { useCallback, useEffect, useRef, useState } from 'react';
import { deviceLinkStatus, interfaceLinkStatus } from '../../engine/index.js';
import { createLabScene } from '../labScene.js';
import { useStore } from '../store.js';
import { PhoneCanvas } from './PhoneCanvas.js';

export function PhoneNetwork() {
  const [view, setView] = useState<'3d' | '2d'>(() =>
    new URLSearchParams(location.search).get('view') === '2d' ? '2d' : '3d',
  );
  const [unavailable, setUnavailable] = useState(false);
  const showMapFallback = useCallback(() => setUnavailable(true), []);
  const network = useStore(s => s.network);
  const selected = useStore(s => s.selectedDeviceId);
  const select = useStore(s => s.selectDevice);
  const liveLinks = network.links.filter(link =>
    interfaceLinkStatus(network, link.a.deviceId, link.a.ifaceId).health === 'up',
  ).length;
  const showBench = view === '3d' && !unavailable;

  return (
    <section className="ph-network" aria-label="Network bench">
      <div className="ph-network-toolbar">
        <span className="ph-link-count">
          <i className={liveLinks ? 'up' : ''} />
          {liveLinks} {liveLinks === 1 ? 'link' : 'links'} online
        </span>
        <div className="workspace-mode" role="group" aria-label="Network view">
          <button type="button" aria-pressed={showBench} disabled={unavailable} onClick={() => setView('3d')}>3D bench</button>
          <button type="button" aria-pressed={!showBench} onClick={() => setView('2d')}>2D map</button>
        </div>
      </div>
      {showBench ? <PhoneBench onError={showMapFallback} /> : <PhoneCanvas />}
      {unavailable && <p className="ph-network-note" role="status">3D is unavailable. The 2D map is ready to use.</p>}
      <nav className="ph-device-picks" aria-label="Inspect a device">
        {network.devices.map(device => (
          <button
            type="button"
            key={device.id}
            aria-pressed={device.id === selected}
            onClick={() => select(device.id === selected ? null : device.id)}
          >
            <i className={`lab-nav-led ${deviceLinkStatus(network, device.id).health}`} />
            {device.label}
          </button>
        ))}
      </nav>
    </section>
  );
}

function PhoneBench({ onError }: { onError: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current || !labels.current) return;
    try {
      const scene = createLabScene(host.current, labels.current, { onError, readOnly: true });
      return () => scene.dispose();
    } catch {
      onError();
      return;
    }
  }, [onError]);

  return (
    <div className="ph-bench">
      <div ref={host} className="lab-renderer" />
      <div ref={labels} className="lab-labels" />
    </div>
  );
}
