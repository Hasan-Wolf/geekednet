/**
 * The phone layout: one stacked, read-only page.
 *
 * Below 900px there is no room for a three-column builder and no pointer to
 * build with, so the phone stops pretending. The lab arrives finished — its own
 * topology, already built and already addressed by {@link solveLab} — and the
 * page reads top to bottom: pick a lab, look at the network, send a packet
 * across it, read what the terminal said, tap a device to see how it is
 * configured. Then a card that says where the building happens.
 *
 * Everything on this page comes from the same engine and the same lab data the
 * desktop uses. The store is the same store, running in its ungraded mode (see
 * `ungraded`), so nothing here can earn XP, a badge or an unlock: this is a
 * view of a lab, not an attempt at one.
 *
 * What is deliberately absent: dragging, cabling, and every editable field.
 */
import { useEffect, useRef } from 'react';
import { deviceLinkStatus, type Device, type Lab } from '../../engine/index.js';
import { useMissionProgress } from '../progress.js';
import { useStore } from '../store.js';
import { PhoneCanvas } from './PhoneCanvas.js';
import { phonePing } from './phonePing.js';

/** Hosts carry a default gateway; a switch has nothing to point anywhere. */
const HOST_KINDS = new Set<Device['kind']>(['pc', 'laptop', 'server']);

export function PhoneApp() {
  const lab = useStore((s) => s.labs.find((l) => l.id === s.phoneLabId) ?? null);
  const loadPhoneLab = useStore((s) => s.loadPhoneLab);

  // Open on the lab the player was last on — solved — and hand the canvas back
  // to their real attempt on the way out, which is what makes crossing the
  // breakpoint in either direction lossless. Read through `getState` so the
  // effect stays a mount/unmount pair rather than re-running on every change.
  useEffect(() => {
    loadPhoneLab(useStore.getState().activeLabId);
    return () => useStore.getState().exitPhoneMode();
  }, [loadPhoneLab]);

  return (
    <div className="ph-app">
      <header className="ph-top">
        <div className="logo">
          Geeked<span className="spark">Net</span>
        </div>
        <span className="ph-tag">Read-only on phone</span>
      </header>

      <LabPicker activeId={lab?.id ?? null} />

      {/* One frame on first mount, before the effect above has loaded a lab.
          Rendering the canvas here would flash the lab's broken starting state. */}
      {lab && (
        <>
          <LabBrief lab={lab} />
          <PhoneCanvas />
          <RunPing lab={lab} />
          <TerminalOut />
          <DeviceCard />
        </>
      )}

      <DesktopCard />
    </div>
  );
}

/**
 * The horizontal lab picker.
 *
 * Every mission, in registry order, scrolling sideways. Unlike the desktop's lab
 * selector this does not lock anything: there is nothing to earn here and
 * nothing to spoil that the solved canvas has not already shown, so the phone is
 * a tour of the whole campaign. A lab the player has finished still says so.
 */
function LabPicker({ activeId }: { activeId: string | null }) {
  const { missions } = useMissionProgress();
  const completedLabs = useStore((s) => s.completedLabs);
  const loadPhoneLab = useStore((s) => s.loadPhoneLab);

  return (
    <nav className="ph-labs" aria-label="Labs">
      <div className="ph-labs-row">
        {missions.map((l) => {
          const active = l.id === activeId;
          return (
            <button
              key={l.id}
              className={`ph-lab${active ? ' active' : ''}`}
              aria-current={active ? 'true' : undefined}
              onClick={() => loadPhoneLab(l.id)}
            >
              <span className="ph-lab-tier">
                Tier {l.tier}
                {completedLabs.includes(l.id) && (
                  <span className="ph-lab-done" aria-label="completed">
                    ✓
                  </span>
                )}
              </span>
              <span className="ph-lab-title">{l.title}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/** The lab's own scenario, plus a word on why it is already working. */
function LabBrief({ lab }: { lab: Lab }) {
  return (
    <section className="ph-panel ph-brief-panel">
      <h1 className="ph-lab-heading">{lab.title}</h1>
      <p className="ph-built">Built &amp; addressed for you</p>
      <p className="ph-brief-text">{lab.brief}</p>
    </section>
  );
}

/**
 * The one button.
 *
 * It runs the lab's own sign-off ping (see `phonePing`) straight through the
 * store's terminal — the same path a typed `ping` takes on desktop — so the
 * engine simulates it, the terminal prints it, and the canvas animates it along
 * the real cable route. Disabled while a packet is in the air, so the button
 * can't stack runs on top of each other.
 */
function RunPing({ lab }: { lab: Lab }) {
  const net = useStore((s) => s.network);
  const flying = useStore((s) => !!s.packet);
  const runTerminal = useStore((s) => s.runTerminal);
  const run = phonePing(lab, net);

  return (
    <div className="ph-ping-wrap">
      <button
        className="ph-ping"
        disabled={!run || flying}
        onClick={() => {
          if (!run) return;
          // Which shell the command runs in. The desktop terminal binds this the
          // same way when a device is selected.
          useStore.setState({ terminalDeviceId: run.fromId });
          runTerminal(`ping ${run.toIp}`);
        }}
      >
        <span className="ph-ping-main">
          <span className="ph-ping-glyph" aria-hidden="true">
            ▶
          </span>
          {flying ? 'Packet in flight…' : 'Run ping'}
        </span>
        <span className="ph-ping-sub">
          {run
            ? `${run.fromLabel} → ${run.toIp}${run.toLabel ? ` (${run.toLabel})` : ''}`
            : 'nothing addressed to ping'}
        </span>
      </button>
    </div>
  );
}

/** The terminal, output only. The ping button is the input. */
function TerminalOut() {
  const log = useStore((s) => s.terminalLog);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  return (
    <section className="ph-panel">
      <h2 className="ph-panel-head">Terminal</h2>
      <div className="ph-term" ref={bodyRef} aria-live="polite">
        {log.map((line, i) => (
          <div key={i} className={`term-line ${line.cls ?? 'plain'}`}>
            {line.text}
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * The tapped device's configuration, as text.
 *
 * The same fields the desktop config panel edits — addresses, masks, gateway,
 * routes — with every input replaced by the value it would hold. Scrolled into
 * view on selection, because the tap that opened it happened further up the page.
 */
function DeviceCard() {
  const net = useStore((s) => s.network);
  const device = useStore(
    (s) => s.network.devices.find((d) => d.id === s.selectedDeviceId) ?? null,
  );
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (device) ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [device?.id]);

  if (!device) {
    return (
      <section className="ph-panel" ref={ref}>
        <h2 className="ph-panel-head">Device</h2>
        <p className="ph-muted">Tap a device on the map to see how it is configured.</p>
      </section>
    );
  }

  const status = deviceLinkStatus(net, device.id);
  const routes = device.routes ?? [];

  return (
    <section className="ph-panel" ref={ref}>
      <h2 className="ph-panel-head">Device</h2>
      <div className="ph-dev-head">
        <div>
          <div className="ph-dev-name">{device.label}</div>
          <div className="ph-dev-kind">{device.kind}</div>
        </div>
        <span className={`ph-dev-link ${status.health}`}>
          {device.powered ? status.reason : `${device.label} is powered off`}
        </span>
      </div>

      <div className="ph-field-label">Interfaces</div>
      {device.interfaces.map((iface) => (
        <div className="ph-iface" key={iface.id}>
          <div className="ph-iface-top">
            <span className="ph-iface-name">{iface.name}</span>
            <span className={`ph-iface-link${iface.linkId ? ' connected' : ''}`}>
              {iface.linkId ? '● link up' : '○ unplugged'}
            </span>
          </div>
          {device.kind === 'switch' || device.kind === 'hub' ? (
            <div className="ph-muted">Layer-2 port — no IP needed.</div>
          ) : (
            <dl className="ph-kv">
              <dt>IP address</dt>
              <dd>{iface.ip ?? '—'}</dd>
              <dt>Subnet mask</dt>
              <dd>{iface.mask ?? '—'}</dd>
            </dl>
          )}
        </div>
      ))}

      {HOST_KINDS.has(device.kind) && (
        <dl className="ph-kv ph-kv-standalone">
          <dt>Default gateway</dt>
          <dd>{device.gateway ?? '—'}</dd>
        </dl>
      )}

      {device.kind === 'router' && (
        <>
          <div className="ph-field-label">Static routes</div>
          {routes.length === 0 ? (
            <p className="ph-muted">No routes — this router only knows its own networks.</p>
          ) : (
            <ul className="ph-routes">
              {routes.map((r, i) => (
                <li key={i}>
                  <code>
                    {r.dst} / {r.mask}
                  </code>
                  <span aria-hidden="true">→</span>
                  <code>{r.gateway}</code>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** Where the building happens. The one thing this layout cannot do for you. */
function DesktopCard() {
  return (
    <aside className="ph-desktop-card">
      <h2>Build it yourself</h2>
      <p>
        Open GeekedNet on a laptop, PC or Mac to drag devices onto the canvas, run your own
        cables, and configure everything yourself.
      </p>
    </aside>
  );
}
