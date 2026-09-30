/** Device palette (left rail). Drag an item onto the canvas to place it. */
import { PALETTE, deviceIcon } from '../devices.js';

export function Palette() {
  return (
    <aside className="palette">
      <h3>Devices</h3>
      <p className="palette-hint">Drag onto the canvas to place.</p>
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
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--brand-cyan)"
            strokeWidth="1.6"
            dangerouslySetInnerHTML={{ __html: deviceIcon(entry.kind) }}
          />
          <div>
            <div className="pi-label">{entry.label}</div>
            <div className="pi-sub">{entry.sub}</div>
          </div>
        </div>
      ))}
    </aside>
  );
}
