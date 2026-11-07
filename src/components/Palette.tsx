/** Device palette (left rail). Drag an item onto the canvas to place it. */
import { useEffect, useState } from 'react';
import { PALETTE, deviceIcon } from '../devices.js';
import { hardwareThumbnail } from '../labModels.js';
import type { DeviceKind } from '../../engine/index.js';

function HardwarePreview({ kind }: { kind: DeviceKind }) {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => { try { setImage(hardwareThumbnail(kind)); } catch { /* Keep the vector fallback on devices without WebGL. */ } }, [kind]);
  return image ? <img className="hardware-thumbnail" src={image} alt="" draggable={false} /> : <svg viewBox="0 0 24 24" fill="none" stroke="var(--brand-cyan)" strokeWidth="1.6" dangerouslySetInnerHTML={{ __html: deviceIcon(kind) }} />;
}

export function Palette() {
  return (
    <aside className="palette">
      <h3>Devices</h3>
      <p className="palette-hint">Drag equipment onto your bench.</p>
      {PALETTE.map((entry) => (
        <div
          key={entry.kind}
          className="palette-item"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('application/geekednet-kind', entry.kind);
            e.dataTransfer.effectAllowed = 'copy';
          }}
        >
          <HardwarePreview kind={entry.kind} />
          <div>
            <div className="pi-label">{entry.label}</div>
            <div className="pi-sub">{entry.sub}</div>
          </div>
        </div>
      ))}
    </aside>
  );
}
