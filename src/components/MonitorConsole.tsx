import { useEffect, useId, useRef } from 'react';
import type { Device } from '../../engine/index.js';
import { useStore } from '../store.js';
import { DeviceAddressing } from './ConfigPanel.js';
import { Terminal } from './Terminal.js';

export function MonitorConsole({ device, onClose }: { device: Device; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const setPower = useStore(s => s.setPower);
  const instructions = useStore(s => s.topologyMode
    ? s.topologies.find(t => t.id === s.topologyId)?.oneLine
    : s.activeLabId === 'sandbox' ? undefined : s.labs.find(l => l.id === s.activeLabId)?.brief);
  const topologyMode = useStore(s => s.topologyMode);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    if (device.powered) dialogRef.current?.querySelector<HTMLInputElement>('[data-monitor-command]')?.focus();
  }, [device.powered]);

  return (
    <dialog ref={dialogRef} className="lab-monitor" aria-labelledby={headingId} onClose={onClose}>
      <div className="lab-monitor-frame">
        <header className="lab-monitor-header">
          <div>
            <p className="lab-monitor-brand">GEEKEDNET · WORKSTATION</p>
            <h2 id={headingId}>{device.label} console</h2>
          </div>
          <button type="button" className="lab-tool" onClick={() => dialogRef.current?.close()}>Back to lab</button>
        </header>
        {device.powered ? (
          <div className="lab-monitor-body">
            <Terminal deviceId={device.id} />
            <section className="lab-monitor-network" aria-label="Network settings">
              <h3>Network settings</h3>
              <DeviceAddressing device={device} />
              {instructions && (
                <details className="lab-monitor-brief">
                  <summary>{topologyMode ? 'About this topology' : 'Mission instructions'}</summary>
                  <p>{instructions}</p>
                </details>
              )}
            </section>
          </div>
        ) : (
          <div className="lab-monitor-off">
            <p>{device.label} is powered off.</p>
            <button type="button" className="lab-run" onClick={() => setPower(device.id, true)}>Power on</button>
          </div>
        )}
      </div>
    </dialog>
  );
}
