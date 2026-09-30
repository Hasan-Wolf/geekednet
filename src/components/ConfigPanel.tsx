/**
 * Per-device config panel (Build Brief §11): IP / mask / gateway plus a simple
 * routing table for routers, and a power toggle (grey → neon). Edits flow straight
 * into the working network via the store; objectives re-check on every keystroke.
 */
import type { Device } from '../../engine/index.js';
import { useStore } from '../store.js';

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
function looksLikeIp(v: string | null | undefined): boolean {
  if (!v) return true; // empty is not "invalid", just unset
  const m = IPV4.exec(v);
  if (!m) return false;
  return m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255);
}

const HOST_KINDS = new Set(['pc', 'laptop', 'server']);

// The three columns of a static route, in order. Driven from data so the caption
// and its input are emitted from one place and can never fall out of step.
const ROUTE_FIELDS = [
  { key: 'dst', label: 'Destination', placeholder: '20.0.0.0' },
  { key: 'mask', label: 'Mask', placeholder: '255.255.255.0' },
  { key: 'gateway', label: 'Gateway', placeholder: '172.16.0.2' },
] as const;

export function ConfigPanel() {
  const selectedId = useStore((s) => s.selectedDeviceId);
  const device = useStore((s) => s.network.devices.find((d) => d.id === selectedId) ?? null);

  if (!device) {
    return (
      <section className="panel">
        <h3>Configuration</h3>
        <p className="cfg-empty">Click a device on the canvas to configure its addressing.</p>
      </section>
    );
  }
  return <DeviceConfig device={device} />;
}

function DeviceConfig({ device }: { device: Device }) {
  const setIfaceField = useStore((s) => s.setIfaceField);
  const setGateway = useStore((s) => s.setGateway);
  const setPower = useStore((s) => s.setPower);
  const addRoute = useStore((s) => s.addRoute);
  const updateRoute = useStore((s) => s.updateRoute);
  const removeRoute = useStore((s) => s.removeRoute);
  const removeDevice = useStore((s) => s.removeDevice);

  const isHost = HOST_KINDS.has(device.kind);
  const isRouter = device.kind === 'router';

  return (
    <section className="panel">
      <div className="cfg-head">
        <div>
          <div className="cfg-title">{device.label}</div>
          <div className="cfg-kind">{device.kind}</div>
        </div>
        <div className="spacer" />
        <button className="btn" onClick={() => removeDevice(device.id)} title="Delete device">
          🗑
        </button>
      </div>

      <label className="power-toggle">
        <input
          type="checkbox"
          checked={device.powered}
          onChange={(e) => setPower(device.id, e.target.checked)}
        />
        Powered {device.powered ? 'on' : 'off'}
      </label>

      <div className="section-label">Interfaces</div>
      {device.interfaces.map((iface) => {
        const connected = !!iface.linkId;
        // A switch/hub just forwards frames — no L3 addressing to configure.
        const addressable = device.kind !== 'switch' && device.kind !== 'hub';
        return (
          <div className="iface-block" key={iface.id}>
            <div className="iface-name">
              <span>{iface.name}</span>
              <span className={`link-state${connected ? ' connected' : ''}`}>
                {connected ? '● link up' : '○ unplugged'}
              </span>
            </div>
            {addressable ? (
              <div className="field-row">
                <div className="field">
                  <label>IP address</label>
                  <input
                    className={looksLikeIp(iface.ip) ? '' : 'invalid'}
                    value={iface.ip ?? ''}
                    placeholder="192.168.1.10"
                    spellCheck={false}
                    onChange={(e) => setIfaceField(device.id, iface.id, 'ip', e.target.value)}
                  />
                </div>
                <div className="field">
                  <label>Subnet mask</label>
                  <input
                    className={looksLikeIp(iface.mask) ? '' : 'invalid'}
                    value={iface.mask ?? ''}
                    placeholder="255.255.255.0"
                    spellCheck={false}
                    onChange={(e) => setIfaceField(device.id, iface.id, 'mask', e.target.value)}
                  />
                </div>
              </div>
            ) : (
              <div className="cfg-empty">Layer-2 port — no IP needed.</div>
            )}
          </div>
        );
      })}

      {isHost && (
        <div className="field">
          <label>Default gateway</label>
          <input
            className={looksLikeIp(device.gateway) ? '' : 'invalid'}
            value={device.gateway ?? ''}
            placeholder="192.168.1.1"
            spellCheck={false}
            onChange={(e) => setGateway(device.id, e.target.value)}
          />
        </div>
      )}

      {isRouter && (
        <>
          <div className="section-label">Static routes</div>
          {(device.routes ?? []).map((route, i) => (
            <div className="route-row" key={i}>
              {ROUTE_FIELDS.map(({ key, label, placeholder }) => {
                const id = `route-${device.id}-${i}-${key}`;
                return (
                  // Each caption is inside its own grid cell with the input it
                  // names, so the two can't drift apart the way a separate header
                  // row did — and they stack together when the panel narrows.
                  <div className="route-field" key={key}>
                    <label htmlFor={id}>{label}</label>
                    <input
                      id={id}
                      value={route[key]}
                      placeholder={placeholder}
                      spellCheck={false}
                      onChange={(e) => updateRoute(device.id, i, key, e.target.value)}
                    />
                  </div>
                );
              })}
              <button className="route-del" onClick={() => removeRoute(device.id, i)} title="Remove route">
                ×
              </button>
            </div>
          ))}
          <button className="btn primary" onClick={() => addRoute(device.id)} style={{ marginTop: 4 }}>
            + Add route
          </button>
        </>
      )}
    </section>
  );
}
