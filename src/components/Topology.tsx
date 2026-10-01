/**
 * Learn Topology — the bar list, the controls on a loaded shape, the side panel,
 * and the explanation Pip reads out.
 *
 * Everything here is driven from a {@link TopologyDemo} and nothing is keyed on
 * which shape it is: the bars, the thumbnails, the badges, the suggested ping
 * and the explanation sections all fall out of one entry's data. Adding an
 * eighth shape to `topologies.json` grows the row by one bar and changes nothing
 * in this file.
 */
import { useStore } from '../store.js';
import {
  demoPing,
  type TopologyDemo,
  type TopologyExplanation,
  type TopologyStatus,
} from '../topologies/index.js';
import type { Device, NetworkState } from '../../engine/index.js';

/** What the badge says. The long form (`statusLabel`) is the tooltip, and gets
 *  the room it needs in the side panel and in Pip's header. */
const STATUS_TEXT: Record<TopologyStatus, string> = {
  current: 'current',
  specialized: 'specialized',
  historical: 'historical',
};

/** The badge. `long` prints the sentence instead of the one word, and drops the
 *  clipped mono treatment that would make a sentence shout.
 *
 *  Exported for the phone layout's own list and header: how current a shape is
 *  is the first thing a student needs, and it must read the same on both. */
export function StatusBadge({ demo, long = false }: { demo: TopologyDemo; long?: boolean }) {
  return (
    <span className={`topo-badge ${demo.status}${long ? ' long' : ''}`} title={demo.statusLabel}>
      {long ? demo.statusLabel : STATUS_TEXT[demo.status]}
    </span>
  );
}

// ---- thumbnail ------------------------------------------------------------

const THUMB_W = 132;
const THUMB_H = 104;
const THUMB_PAD = 10;
/** Canvas node footprint, so a thumbnail is measured from box centres like the
 *  real cables are. Mirrors NODE_W / BOX_H in Canvas. */
const NODE_W = 92;
const BOX_H = 60;

/** Infrastructure is drawn as a square, a host as a dot — the same distinction
 *  the canvas makes with its icons, at 4px. */
const HOST_KINDS: ReadonlySet<Device['kind']> = new Set<Device['kind']>(['pc', 'laptop', 'server']);

/**
 * A shape's own wiring, shrunk to fit the bar.
 *
 * Drawn from the demo's `initialState` rather than from a picture someone drew,
 * so it cannot disagree with what loading the bar actually puts on the canvas —
 * and a new topology gets its thumbnail for free.
 *
 * Exported because the phone lists the same shapes down the page instead of
 * across it, and the thumbnail is the part of a row that says which shape it is.
 * The drawing is viewBox-scaled, so the row only has to choose a width.
 */
export function TopologyThumb({ net }: { net: NetworkState }) {
  const centres = new Map<string, { x: number; y: number }>(
    net.devices.map((d) => [d.id, { x: d.x + NODE_W / 2, y: d.y + BOX_H / 2 }]),
  );
  const pts = [...centres.values()];
  if (pts.length === 0) return null;

  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX;
  const spanY = Math.max(...ys) - minY;
  const scale = Math.min(
    (THUMB_W - THUMB_PAD * 2) / (spanX || 1),
    (THUMB_H - THUMB_PAD * 2) / (spanY || 1),
  );
  // Centred in whichever direction has slack, so a wide shape doesn't hug the
  // top edge and a tall one doesn't hug the left.
  const offX = (THUMB_W - spanX * scale) / 2;
  const offY = (THUMB_H - spanY * scale) / 2;
  const at = (id: string) => {
    const c = centres.get(id);
    return c ? { x: (c.x - minX) * scale + offX, y: (c.y - minY) * scale + offY } : null;
  };

  return (
    <svg
      className="topo-thumb"
      viewBox={`0 0 ${THUMB_W} ${THUMB_H}`}
      aria-hidden="true"
      focusable="false"
    >
      {net.links.map((link) => {
        const a = at(link.a.deviceId);
        const b = at(link.b.deviceId);
        if (!a || !b) return null;
        return <line key={link.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
      })}
      {net.devices.map((d) => {
        const p = at(d.id);
        if (!p) return null;
        return HOST_KINDS.has(d.kind) ? (
          <circle key={d.id} cx={p.x} cy={p.y} r={3.1} className="host" />
        ) : (
          <rect key={d.id} x={p.x - 3.4} y={p.y - 3.4} width={6.8} height={6.8} rx={1.4} />
        );
      })}
    </svg>
  );
}

// ---- the bar list ---------------------------------------------------------

/**
 * The row of bars across the canvas, one per shape, in registry order.
 *
 * Scrolls sideways rather than wrapping: "left to right" is the layout, and a
 * bar that reflowed onto a second line would stop reading as one row of choices.
 */
export function TopologyBrowser() {
  const topologies = useStore((s) => s.topologies);
  const loadTopology = useStore((s) => s.loadTopology);

  return (
    <div className="topo-browser">
      <div className="topo-browser-head">
        <h2>Learn Topology</h2>
        <p>
          Seven shapes a network can take. Pick one and it loads fully built and fully
          addressed — open the terminal and ping straight away, then break it and see what
          happens. These are demos: nothing here is scored.
        </p>
      </div>
      <div className="topo-row" role="list">
        {topologies.map((t) => (
          <button
            key={t.id}
            role="listitem"
            className={`topo-bar ${t.status}`}
            onClick={() => loadTopology(t.id)}
            title={`${t.name} — ${t.statusLabel}`}
          >
            <TopologyThumb net={t.initialState} />
            <span className="tb-name">{t.name}</span>
            <span className="tb-line">{t.oneLine}</span>
            <StatusBadge demo={t} />
          </button>
        ))}
      </div>
    </div>
  );
}

// ---- controls on a loaded shape ------------------------------------------

/**
 * The way back, and the way to undo the damage.
 *
 * Both live in the canvas toolbar, above the topology itself: the bar list is on
 * the canvas, so the control that returns to it belongs there too rather than
 * buried in a side panel the student may have scrolled.
 */
export function TopologyControls({ demo }: { demo: TopologyDemo }) {
  const back = useStore((s) => s.backToTopologies);
  const reset = useStore((s) => s.resetTopology);

  return (
    <>
      <button className="btn topo-back" onClick={back}>
        ← All topologies
      </button>
      <button className="btn" onClick={reset} title={`Restore ${demo.name} to how it loaded`}>
        ↻ Reset shape
      </button>
    </>
  );
}

// ---- side panel ----------------------------------------------------------

/** Where the Objectives panel sits in a lab. A demo has no objectives, so this
 *  carries the shape's identity, the ping worth trying, and the way back. */
export function TopologyPanel() {
  const demo = useStore((s) => s.topologies.find((t) => t.id === s.topologyId) ?? null);
  const net = useStore((s) => s.network);
  const back = useStore((s) => s.backToTopologies);
  const reset = useStore((s) => s.resetTopology);

  if (!demo) {
    return (
      <section className="panel">
        <h3>Learn Topology</h3>
        <p className="brief">
          Pick a shape from the bars on the canvas. Each one loads already built and already
          addressed, so you can ping across it immediately — and edit it however you like
          afterwards.
        </p>
        <p className="cfg-empty">
          No objectives, no XP, no badges. Nothing here counts toward your missions.
        </p>
      </section>
    );
  }

  // Re-derived from live state, so it still names a real address after the
  // student has re-addressed something.
  const suggestion = demoPing(net);

  return (
    <section className="panel">
      <h3>{demo.name}</h3>
      <div className="topo-panel-badge">
        <StatusBadge demo={demo} long />
      </div>
      <p className="brief">{demo.oneLine}</p>

      {suggestion && (
        <div className="topo-try" role="note">
          <strong>Try it</strong>
          <p>
            Click <b>{suggestion.from.label}</b>, then run <code>ping {suggestion.toIp}</code> in
            the terminal to watch a packet cross the shape.
          </p>
        </div>
      )}

      <p className="cfg-empty">
        Ask Pip (bottom right) what this shape is and where it’s used. Edits are yours to make —
        pull a cable, change an address, delete a device — and <b>Reset shape</b> puts it all
        back.
      </p>

      <div className="topo-panel-actions">
        <button className="btn topo-back" onClick={back}>
          ← All topologies
        </button>
        <button className="btn" onClick={reset}>
          ↻ Reset shape
        </button>
      </div>
    </section>
  );
}

// ---- Pip's explanation ---------------------------------------------------

export type Block =
  | { kind: 'prose'; label: string; text: string }
  /** `tone` only marks the bullets — cyan for what a shape buys you, magenta for
   *  what it costs — so the two lists are tellable apart at a glance. */
  | { kind: 'list'; label: string; tone: 'plus' | 'minus'; items: string[] };

/**
 * The explanation, in reading order.
 *
 * Rendered from the separate fields rather than as one blob: each section gets
 * its own heading and its own short paragraph, and the two lists stay lists, so
 * the whole thing is skimmable in a panel the size of Pip's drawer.
 *
 * Exported because the phone shows the same explanation in a disclosure under
 * its canvas. Which fields there are, what each is called and what order they
 * read in is a content decision, and it is made here once — the phone chooses
 * only the container it puts them in.
 */
export function explanationBlocks(e: TopologyExplanation): Block[] {
  return [
    { kind: 'prose', label: 'What it is', text: e.whatItIs },
    { kind: 'prose', label: 'How data travels', text: e.howDataTravels },
    { kind: 'prose', label: 'Where it’s used today', text: e.whereUsedToday },
    { kind: 'list', label: 'Advantages', tone: 'plus', items: e.advantages },
    { kind: 'list', label: 'Drawbacks', tone: 'minus', items: e.drawbacks },
    { kind: 'prose', label: 'Good to know', text: e.goodToKnow },
  ];
}

export function TopologyExplainer({ demo }: { demo: TopologyDemo }) {
  const sources = demo.explanation.sources;
  return (
    <>
      <div className="topo-explain-head">
        <div className="topo-explain-name">{demo.name}</div>
        <StatusBadge demo={demo} long />
      </div>
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
    </>
  );
}
