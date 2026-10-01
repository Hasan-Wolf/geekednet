/**
 * The phone layout: one stacked, read-only page, in two sections.
 *
 * Below 900px there is no room for a three-column builder and no pointer to
 * build with, so the phone stops pretending. **Labs** arrive finished — each
 * lab's own topology, already built and already addressed by {@link solveLab} —
 * and **Learn Topology** offers the seven shapes, which already ship built and
 * addressed. Either way the page reads top to bottom: pick something, look at
 * the network, send a packet across it, read what the terminal said, tap a
 * device to see how it is configured. Then a card that says where the building
 * happens.
 *
 * The two sections share everything below the picker — the same tap-only canvas,
 * the same Run ping button, the same terminal and device card — because on this
 * screen a lab and a demo are the same thing: a finished network you can send a
 * packet across. Only what sits above differs, and a topology adds Pip's
 * explanation below.
 *
 * Everything here comes from the same engine, the same lab files and the same
 * topology registry the desktop uses. The store is the same store, and both
 * sections run it ungraded (see `ungraded`), so nothing on this page can earn
 * XP, a badge or an unlock: this is a view of a lab, not an attempt at one.
 *
 * What is deliberately absent: dragging, cabling, and every editable field.
 */
import { useEffect, useRef } from 'react';
import { deviceLinkStatus, type Device, type Lab } from '../../engine/index.js';
import {
  StatusBadge,
  TopologyThumb,
  explanationBlocks,
} from '../components/Topology.js';
import { useMissionProgress } from '../progress.js';
import { useStore } from '../store.js';
import type { TopologyDemo } from '../topologies/index.js';
import { PhoneCanvas } from './PhoneCanvas.js';
import { phonePing } from './phonePing.js';

/** Hosts carry a default gateway; a switch has nothing to point anywhere. */
const HOST_KINDS = new Set<Device['kind']>(['pc', 'laptop', 'server']);

export function PhoneApp() {
  // Which section owns the canvas is not a second source of truth: the store
  // already answers it, because the two share one canvas and `freshCanvas`
  // lets only one hold it at a time.
  const inTopology = useStore((s) => s.topologyMode);
  const phoneLabId = useStore((s) => s.phoneLabId);
  const loadPhoneLab = useStore((s) => s.loadPhoneLab);
  const enterTopologyMode = useStore((s) => s.enterTopologyMode);

  // The lab to come back to when Labs is re-selected. The store clears
  // `phoneLabId` when Learn Topology takes the canvas — which is what keeps the
  // two exclusive — so the toggle remembers it here rather than returning the
  // player to lab one every time they look at a shape.
  const lastLabId = useRef<string | null>(null);
  useEffect(() => {
    if (phoneLabId) lastLabId.current = phoneLabId;
  }, [phoneLabId]);

  // Open on whatever the desktop had: a Learn Topology shape (or its list) is
  // already on the canvas and renders here as-is, so only a lab needs loading.
  // Handing it back on the way out is what makes crossing the breakpoint in
  // either direction lossless. Read through `getState` so the effect stays a
  // mount/unmount pair rather than re-running on every change.
  useEffect(() => {
    const s = useStore.getState();
    if (!s.topologyMode) s.loadPhoneLab(s.activeLabId);
    return () => useStore.getState().exitPhoneMode();
  }, []);

  return (
    <div className="ph-app">
      <header className="ph-top">
        <div className="logo">
          Geeked<span className="spark">Net</span>
        </div>
        <span className="ph-tag">Read-only on phone</span>
      </header>

      <SectionToggle
        inTopology={inTopology}
        onLabs={() =>
          loadPhoneLab(lastLabId.current ?? useStore.getState().activeLabId)
        }
        onTopology={enterTopologyMode}
      />

      {inTopology ? <TopologySection /> : <LabsSection />}

      <DesktopCard />
    </div>
  );
}

/**
 * Labs or Learn Topology.
 *
 * The desktop puts Learn Topology beside the four campaign phases, as a fifth
 * tab among things that are mostly locked. There is no room for that here and
 * nothing to lock, so the phone states the real choice: the missions, or the
 * shapes.
 */
function SectionToggle({
  inTopology,
  onLabs,
  onTopology,
}: {
  inTopology: boolean;
  onLabs: () => void;
  onTopology: () => void;
}) {
  return (
    <div className="ph-toggle" role="tablist" aria-label="Section">
      <button
        role="tab"
        aria-selected={!inTopology}
        className={`ph-toggle-btn${inTopology ? '' : ' active'}`}
        onClick={() => inTopology && onLabs()}
      >
        Labs
      </button>
      <button
        role="tab"
        aria-selected={inTopology}
        className={`ph-toggle-btn${inTopology ? ' active' : ''}`}
        onClick={() => !inTopology && onTopology()}
      >
        Learn Topology
      </button>
    </div>
  );
}

/** The missions: pick one, and it is on the canvas finished. */
function LabsSection() {
  const lab = useStore((s) => s.labs.find((l) => l.id === s.phoneLabId) ?? null);

  return (
    <>
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
    </>
  );
}

/**
 * The seven shapes: the list, or one of them loaded.
 *
 * Both states come straight from the store's existing Learn Topology actions —
 * the same `enterTopologyMode` / `loadTopology` / `backToTopologies` the desktop
 * drives, over the same registry. The phone adds no topology state of its own
 * and no second copy of a shape: `topologyId === null` is the list, and anything
 * else is that shape, already built and addressed, on the shared canvas.
 */
function TopologySection() {
  const demo = useStore((s) => s.topologies.find((t) => t.id === s.topologyId) ?? null);
  return demo ? <LoadedTopology demo={demo} /> : <TopologyList />;
}

/**
 * The shapes, down the page.
 *
 * The desktop runs these across the canvas as one row of tall bars, which is the
 * right shape for a wide canvas and the wrong one for a handset: seven bars
 * side by side on a phone are seven slivers. Here each is a full-width row —
 * thumbnail, name, what it is, how current it is — and the page scrolls, which
 * is the gesture a phone already expects. Same registry, same thumbnails, same
 * badges; only the direction changes.
 */
function TopologyList() {
  const topologies = useStore((s) => s.topologies);
  const loadTopology = useStore((s) => s.loadTopology);

  return (
    <section className="ph-panel">
      <h2 className="ph-panel-head">Learn Topology</h2>
      <p className="ph-muted ph-topo-intro">
        Seven shapes a network can take. Tap one and it loads fully built and fully
        addressed — send a packet across it and read what it is. Demos, not labs: nothing
        here is scored.
      </p>
      <ul className="ph-topo-list">
        {topologies.map((t) => (
          <li key={t.id}>
            <button className={`ph-topo ${t.status}`} onClick={() => loadTopology(t.id)}>
              <TopologyThumb net={t.initialState} />
              <span className="ph-topo-text">
                <span className="ph-topo-name">{t.name}</span>
                <span className="ph-topo-line">{t.oneLine}</span>
                <StatusBadge demo={t} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One shape on the canvas: the same stack a lab gets, plus Pip's explanation. */
function LoadedTopology({ demo }: { demo: TopologyDemo }) {
  const back = useStore((s) => s.backToTopologies);

  return (
    <>
      <section className="ph-panel ph-brief-panel">
        <button className="ph-back" onClick={back}>
          ← All topologies
        </button>
        <h1 className="ph-lab-heading">{demo.name}</h1>
        <div className="ph-topo-badge">
          <StatusBadge demo={demo} long />
        </div>
        <p className="ph-brief-text">{demo.oneLine}</p>
      </section>

      <PhoneCanvas />
      {/* No lab behind a demo, so the button falls back to the derivation Learn
          Topology already uses — see phonePing. */}
      <RunPing lab={null} />
      <Explanation demo={demo} />
      <TerminalOut />
      <DeviceCard />
    </>
  );
}

/**
 * Pip's explanation, folded away under the canvas.
 *
 * The desktop has a drawer to put this in; the phone has one column, and six
 * sections of prose between the canvas and the terminal would bury both. So it
 * is a disclosure — closed by default, open with one tap — and a native
 * `<details>` rather than a hand-rolled one, which gets the keyboard, the
 * accessibility tree and find-in-page for free.
 *
 * The sections themselves are `explanationBlocks`, the desktop's own: which
 * fields exist, what each is called and the order they read in are decided once,
 * in the component that already renders them. This chooses the container only,
 * and reuses the same `.topo-explain` styling inside it.
 */
function Explanation({ demo }: { demo: TopologyDemo }) {
  const sources = demo.explanation.sources;
  return (
    <details className="ph-explain">
      <summary>
        <span className="ph-explain-title">What this shape is</span>
        <span className="ph-explain-sub">
          How data travels, where it’s used, what it costs
        </span>
      </summary>
      <div className="ph-explain-body">
        {explanationBlocks(demo.explanation).map((block) => (
          <section
            className={`topo-explain${block.kind === 'list' ? ` ${block.tone}` : ''}`}
            key={block.label}
          >
            <h4>{block.label}</h4>
            {block.kind === 'prose' ? (
              <p>{block.text}</p>
            ) : (
              <ul>
                {block.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </section>
        ))}
        {sources && sources.length > 0 && (
          <p className="topo-sources">Sources: {sources.join(' · ')}</p>
        )}
      </div>
    </details>
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
function RunPing({ lab }: { lab: Lab | null }) {
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
