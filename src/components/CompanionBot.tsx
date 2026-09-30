/**
 * Companion bot "Pip" (Build Brief §8) — docked bottom-right in every lab.
 * v1 is the scripted hint tree: proactive openers in Learn mode, escalating
 * hints (nudge → guide → near-answer) from `lab.hints` on request. Same data
 * shape a live LLM tutor would later slot behind (v1.5).
 */
import { useEffect, useRef, useState } from 'react';
import { getDevice, verifyTargetIp } from '../../engine/index.js';
import { useStore } from '../store.js';
import { TopologyExplainer } from './Topology.js';

const BOT_NAME = 'Pip';

/**
 * Where Pip sits, as a distance from the bottom-right of the canvas.
 *
 * Anchored to that corner rather than the top-left on purpose: the orb is the
 * rightmost thing in the panel, so growing the drawer opens it leftward and the
 * orb stays exactly where the student put it.
 */
interface BotPos {
  right: number;
  bottom: number;
}

export const DEFAULT_POS: BotPos = { right: 18, bottom: 18 };

/**
 * How big the open drawer is.
 *
 * A size, not a zoom: the type inside stays at the same readable pixel sizes at
 * every width, so a narrower panel means shorter lines and more scrolling
 * rather than finer print.
 */
interface BotSize {
  width: number;
  height: number;
}

/** The size the drawer always had — now a starting point rather than a law. */
export const DEFAULT_SIZE: BotSize = { width: 260, height: 320 };
/**
 * The starting point when Pip is holding a topology explanation instead of a
 * hint: six sections rather than one line, which the hint drawer turns into a
 * keyhole. Still only a default — a size the student has set by hand wins, and
 * the canvas clamp still applies.
 */
export const EXPLAIN_SIZE: BotSize = { width: 400, height: 470 };
/** Small enough to tuck out of the way, never so small that the header and one
 *  hint stop fitting. */
export const MIN_SIZE: BotSize = { width: 200, height: 150 };
/** Room for the longest near-answer hint and no more: Pip is a companion to the
 *  canvas, not a replacement for it. */
export const MAX_SIZE: BotSize = { width: 560, height: 620 };

/** Which edges a grip drives: the right edge, the bottom edge, or a corner. */
export type GripAxis = 'x' | 'y' | 'br' | 'tl';

/**
 * Which way the pointer has to travel, per grip, to make the panel bigger.
 *
 * The panel is anchored to its bottom-right, so that corner and the two edges
 * beside it are pinned: room opens away from them, and the pointer's travel out
 * from the anchor is the size delta. The top-left corner is the free one — it is
 * the corner that actually moves when the panel grows — so it pulls the other
 * way and tracks the pointer exactly.
 */
const GRIP_SIGNS: Record<GripAxis, { x: number; y: number }> = {
  x: { x: 1, y: 0 },
  y: { x: 0, y: 1 },
  br: { x: 1, y: 1 },
  tl: { x: -1, y: -1 },
};

/** The size a drag of (dx, dy) on this grip asks for, before any clamping. */
export function resizeBy(axis: GripAxis, from: BotSize, dx: number, dy: number): BotSize {
  const sign = GRIP_SIGNS[axis];
  return { width: from.width + sign.x * dx, height: from.height + sign.y * dy };
}

const POS_KEY = 'geekednet.pip.pos.v1';
/** Stored beside the position rather than inside it, so a corrupt size falls
 *  back to the default without also losing where the student parked Pip. */
const SIZE_KEY = 'geekednet.pip.size.v1';
/**
 * Pointer travel, in px, below which a press on the orb is still a click.
 *
 * The orb is both the drawer's toggle and a handle for carrying Pip around, so
 * a gesture has to declare itself. This is the slop an ordinary click leaves
 * behind on a steady hand — past it, the press was a move, and the click that
 * the browser fires afterwards gets swallowed.
 */
const DRAG_SLOP = 4;
/** Kept clear of the canvas edges, and of the win bar when it is up. */
const EDGE_MARGIN = 8;
const WIN_BAR_CLEARANCE = 84;
/** The strip the orb keeps beside the drawer: its width plus the flex gap. */
const ORB_LANE = 58;
/** The most of the canvas, in either direction, that Pip may take. A generous
 *  panel is fine; a panel with the network peeking out from behind it is not. */
const MAX_CANVAS_SHARE = 0.75;

function loadPos(): BotPos {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return DEFAULT_POS;
    const parsed = JSON.parse(raw) as Partial<BotPos>;
    if (typeof parsed.right !== 'number' || typeof parsed.bottom !== 'number') return DEFAULT_POS;
    if (!Number.isFinite(parsed.right) || !Number.isFinite(parsed.bottom)) return DEFAULT_POS;
    return { right: parsed.right, bottom: parsed.bottom };
  } catch {
    return DEFAULT_POS; // private window, blocked storage — the default still works
  }
}

function savePos(pos: BotPos | null) {
  try {
    if (pos) localStorage.setItem(POS_KEY, JSON.stringify(pos));
    else localStorage.removeItem(POS_KEY);
  } catch {
    /* storage unavailable — the position simply will not persist */
  }
}

/**
 * The size the student last set, or null if they never have.
 *
 * Null rather than the default on purpose: what the right default *is* depends
 * on what Pip is currently holding (a one-line hint or a full explanation), and
 * collapsing "never chosen" into one of them here would take that choice away.
 * See `shown`.
 */
function loadSize(): BotSize | null {
  try {
    const raw = localStorage.getItem(SIZE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BotSize>;
    if (typeof parsed.width !== 'number' || typeof parsed.height !== 'number') return null;
    if (!Number.isFinite(parsed.width) || !Number.isFinite(parsed.height)) return null;
    return { width: parsed.width, height: parsed.height };
  } catch {
    return null; // private window, blocked storage — the default still works
  }
}

function saveSize(size: BotSize | null) {
  try {
    if (size) localStorage.setItem(SIZE_KEY, JSON.stringify(size));
    else localStorage.removeItem(SIZE_KEY);
  } catch {
    /* storage unavailable — the size simply will not persist */
  }
}

/**
 * Hold the panel inside the canvas it belongs to.
 *
 * Fully inside, not merely "mostly": a panel with two pixels showing is a panel
 * the student cannot get hold of again, and its header is the only way to move
 * it back. When the canvas is smaller than the panel the clamp collapses to the
 * near edge rather than inverting.
 */
export function clampPos(
  pos: BotPos,
  panel: { width: number; height: number },
  canvas: { width: number; height: number },
  winOpen: boolean,
): BotPos {
  const maxRight = Math.max(EDGE_MARGIN, canvas.width - panel.width - EDGE_MARGIN);
  const maxBottom = Math.max(EDGE_MARGIN, canvas.height - panel.height - EDGE_MARGIN);
  const minBottom = winOpen ? WIN_BAR_CLEARANCE : EDGE_MARGIN;
  return {
    right: Math.min(Math.max(pos.right, EDGE_MARGIN), maxRight),
    bottom: Math.min(Math.max(pos.bottom, minBottom), Math.max(minBottom, maxBottom)),
  };
}

/**
 * Hold the drawer to a size that is still a panel.
 *
 * Two ceilings, the lower one winning: a flat maximum, and a share of the canvas
 * so Pip stays a panel on a small window rather than becoming the window. The
 * share is measured against the whole companion — the orb's strip counts as room
 * Pip has taken — so it is the drawer that gives the strip back. On a canvas too
 * small for even the minimum the floor wins instead: a cramped panel the student
 * can still read and drag beats one squeezed to nothing, and `clampPos` then
 * parks it against the near edge.
 */
export function clampSize(size: BotSize, canvas: { width: number; height: number }): BotSize {
  const fitWidth = Math.floor(canvas.width * MAX_CANVAS_SHARE) - ORB_LANE;
  const fitHeight = Math.floor(canvas.height * MAX_CANVAS_SHARE);
  const maxWidth = Math.max(MIN_SIZE.width, Math.min(MAX_SIZE.width, fitWidth));
  const maxHeight = Math.max(MIN_SIZE.height, Math.min(MAX_SIZE.height, fitHeight));
  return {
    width: Math.min(Math.max(size.width, MIN_SIZE.width), maxWidth),
    height: Math.min(Math.max(size.height, MIN_SIZE.height), maxHeight),
  };
}


export function CompanionBot() {
  const labId = useStore((s) => s.activeLabId);
  const lab = useStore((s) => s.labs.find((l) => l.id === labId)!);
  const results = useStore((s) => s.objectiveResults);
  const verifyStatus = useStore((s) => s.verifyStatus);
  const net = useStore((s) => s.network);
  /** Set when a Learn Topology shape is on the canvas: Pip then carries that
   *  shape's explanation instead of a lab's hint tree. */
  const demo = useStore((s) => s.topologies.find((t) => t.id === s.topologyId) ?? null);

  const [open, setOpen] = useState(false);
  const [hintLevel, setHintLevel] = useState(0); // how many hints revealed
  const [openerDismissed, setOpenerDismissed] = useState(false);

  // ---- dragging and resizing ----
  const rootRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<BotPos>(loadPos);
  /** The size the student asked for — held unclamped, and null until they ask
   *  for one at all. See `shown`. */
  const [size, setSize] = useState<BotSize | null>(loadSize);
  const [canvas, setCanvas] = useState<{ width: number; height: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState<GripAxis | null>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    from: BotPos;
    moved: boolean;
  } | null>(null);
  /** Set when the gesture that just ended was a move, so the orb's click can
   *  tell "carried Pip across the canvas" from "asked Pip to open". */
  const draggedRef = useRef(false);
  const resizeRef = useRef<{
    startX: number;
    startY: number;
    from: BotSize;
    axis: GripAxis;
    latest: BotSize;
  } | null>(null);
  const winOpen = useStore((s) => !!s.justCompleted);

  // Reset per lab — and per topology, which swaps what Pip is holding just as
  // completely as switching labs does.
  useEffect(() => {
    setOpen(false);
    setHintLevel(0);
    setOpenerDismissed(false);
  }, [labId, demo?.id]);

  /** The canvas Pip is docked in — its positioning context. */
  const canvasRect = () => rootRef.current?.offsetParent?.getBoundingClientRect() ?? null;

  /** Re-clamp against the box it is in, whatever changed it. Run after a drag,
   *  when the window resizes, and when the win bar takes the bottom strip. */
  function settle(next: BotPos) {
    const panel = rootRef.current?.getBoundingClientRect();
    const canvas = canvasRect();
    return panel && canvas ? clampPos(next, panel, canvas, winOpen) : next;
  }

  /** The same, for the panel box, against the canvas as last measured. */
  function settleSize(next: BotSize) {
    return canvas ? clampSize(next, canvas) : next;
  }

  // Watch the canvas box itself rather than the window. It is a grid cell, so it
  // changes for reasons the window never hears about — and on the first paint it
  // is briefly zero, which a one-shot measurement would read as "no room".
  useEffect(() => {
    const box = rootRef.current?.offsetParent;
    if (!(box instanceof Element) || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const r = box.getBoundingClientRect();
      setCanvas({ width: r.width, height: r.height });
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onResize = () => setPos((p) => settle(p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // `settle` closes over winOpen, so re-bind when the bar comes and goes.
  }, [winOpen]);

  /**
   * The size actually rendered: what the student chose, held to what the canvas
   * can carry today.
   *
   * Derived rather than written back, so a canvas that is briefly zero on the
   * first paint — or a window dragged narrow and wide again — borrows the panel
   * down and hands it back, instead of quietly overwriting a size the student
   * set in a roomier window and can no longer recover.
   */
  const shown = settleSize(size ?? (demo ? EXPLAIN_SIZE : DEFAULT_SIZE));

  // The win bar claims the bottom strip; a Pip parked down there would vanish
  // behind it at the exact moment the student is being congratulated. A panel
  // that has just grown has the same problem against the far edges, so a new
  // size — or a new canvas under it — re-settles the position too.
  useEffect(() => {
    setPos((p) => settle(p));
  }, [winOpen, open, shown.width, shown.height, canvas?.width, canvas?.height]);

  /**
   * Start a move. Bound to both of Pip's handles: the drawer header, and the orb
   * itself — which is the only handle there is while the drawer is shut, and the
   * one the hand reaches for first either way.
   */
  function onDragPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    // Cleared here rather than after the click, so a gesture the browser
    // cancelled mid-flight cannot leave the next real click suppressed.
    draggedRef.current = false;
    dragRef.current = { startX: e.clientX, startY: e.clientY, from: pos, moved: false };
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onHeadPointerDown(e: React.PointerEvent) {
    // Header only: it carries the reset and close buttons, and a drag that
    // started on one would swallow the click.
    if ((e.target as HTMLElement).closest('button')) return;
    onDragPointerDown(e);
  }

  function onDragPointerMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    // A real dead zone, not just a label: until the gesture clears the slop it
    // is still a click, and Pip holds still. A press that wobbles by a pixel
    // must not shift him, least of all write that pixel down as his new home.
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) <= DRAG_SLOP) return;
    drag.moved = true;
    // Right/bottom anchored, so the panel follows the pointer by moving away
    // from the corner it is measured from.
    setPos(settle({ right: drag.from.right - dx, bottom: drag.from.bottom - dy }));
  }

  function onDragPointerUp(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
    setDragging(false);
    draggedRef.current = drag.moved;
    // Nothing cleared the dead zone, so nothing moved: no position to settle,
    // and nothing that a click on the orb should be persisting.
    if (!drag.moved) return;
    setPos((p) => {
      const settled = settle(p);
      savePos(settled);
      return settled;
    });
  }

  /**
   * Resize from the right edge, the bottom edge, or either corner.
   *
   * The orb stays exactly where the student put it, so the panel is anchored to
   * its bottom-right and the extra room always opens out to the left and up.
   * That is why the two corners feel different under the hand: the bottom-right
   * one is pinned and stays put while the pointer's travel out from it sizes the
   * panel, whereas the top-left one is the free corner and simply follows the
   * pointer. `GRIP_SIGNS` carries that difference; the gesture is the same one
   * either way — drag out from the anchor to grow, back toward it to shrink.
   */
  function onGripPointerDown(e: React.PointerEvent, axis: GripAxis) {
    e.preventDefault();
    // `shown`, not `size`: the drag starts from the panel on screen, so one that
    // a narrow canvas is holding down does not leap out to its stored size.
    resizeRef.current = { startX: e.clientX, startY: e.clientY, from: shown, axis, latest: shown };
    setResizing(axis);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onGripPointerMove(e: React.PointerEvent) {
    const grip = resizeRef.current;
    if (!grip) return;
    // Clamped as it goes, so what gets written down is a size that fits: a drag
    // past the cap should stop, not bank room to spring open with later.
    grip.latest = settleSize(
      resizeBy(grip.axis, grip.from, e.clientX - grip.startX, e.clientY - grip.startY),
    );
    setSize(grip.latest);
  }

  function onGripPointerUp(e: React.PointerEvent) {
    const grip = resizeRef.current;
    if (!grip) return;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    resizeRef.current = null;
    setResizing(null);
    saveSize(grip.latest);
  }

  /** Both halves of the layout at once — a panel dragged somewhere odd is
   *  usually a panel sized to something odd as well. */
  function resetLayout() {
    setPos(DEFAULT_POS);
    // Back to "never chosen", so the default that fits what Pip is holding
    // takes over again rather than the hint-sized one winning everywhere.
    setSize(null);
    savePos(null);
    saveSize(null);
  }

  const allDone = results.length > 0 && results.every((o) => o.complete);
  // A demo has no hint tree and nothing to complete, so Pip's one job there is
  // to hold the explanation — and to say so, once, until he is opened.
  const proactive = demo ? !openerDismissed : lab.mode === 'learn' && !openerDismissed && !allDone;
  const opener = demo
    ? `${demo.name} — ${demo.oneLine} Click me for what it is, how data travels and where it’s used.`
    : lab.botOpeners?.[0];

  const revealNext = () => setHintLevel((n) => Math.min(lab.hints.length, n + 1));

  // Green objectives are no longer the end of the story for a lab that names a
  // verifying ping — don't send the student off to the next one before it lands.
  const signOff = (): string => {
    if (verifyStatus === 'verifying') return 'Packet away — watch it land.';
    const v = lab.verify;
    if (verifyStatus === 'ready' && v) {
      const from = getDevice(net, v.from)?.label ?? v.from;
      // Resolved live: on a lab where the student chose the target's address,
      // naming a literal here would send them off to ping the wrong machine.
      const target =
        verifyTargetIp(lab, net) ??
        (v.toDevice ? (getDevice(net, v.toDevice)?.label ?? v.toDevice) : v.toIp);
      return `The config reads right — but I don’t call a network working until a packet crosses it. Run ping ${target} from ${from}.`;
    }
    return 'Nice work — every objective is green. Try the next lab!';
  };

  return (
    <div
      ref={rootRef}
      className={`bot${dragging ? ' dragging' : ''}${
        resizing ? ` resizing resizing-${resizing}` : ''
      }`}
      style={{ right: pos.right, bottom: pos.bottom }}
    >
      <button
        className={`bot-orb${proactive && !open ? ' nudging' : ''}`}
        title={
          demo
            ? `${BOT_NAME} — click for the ${demo.name} explanation · drag to move`
            : `${BOT_NAME} — your lab companion · click to talk, drag to move`
        }
        onPointerDown={onDragPointerDown}
        onPointerMove={onDragPointerMove}
        onPointerUp={onDragPointerUp}
        onPointerCancel={onDragPointerUp}
        onClick={() => {
          // A drag that ends on the orb still fires a click. Swallow that one:
          // putting Pip down somewhere new should not also open the drawer.
          if (draggedRef.current) {
            draggedRef.current = false;
            return;
          }
          setOpen((v) => !v);
          setOpenerDismissed(true);
        }}
      >
        <span className="bot-eye" />
      </button>

      {!open && proactive && opener && (
        <div className="bot-drawer" style={{ maxWidth: 240 }}>
          <div className="bot-msgs">
            <div className="bot-msg">{opener}</div>
          </div>
        </div>
      )}

      {open && (
        <div
          className={`bot-drawer bot-panel${demo ? ' bot-explain' : ''}`}
          style={{ width: shown.width, height: shown.height }}
        >
          {/* The drag handle. Scoped to the header so the hint button below it
              stays a button — a drag that began anywhere in the body would eat
              the click that reveals the next hint. */}
          <div
            className="bot-drawer-head"
            onPointerDown={onHeadPointerDown}
            onPointerMove={onDragPointerMove}
            onPointerUp={onDragPointerUp}
            onPointerCancel={onDragPointerUp}
          >
            <div className="bot-name">
              {BOT_NAME}
              <small>drag me · {demo ? 'topology' : lab.mode}</small>
            </div>
            <button
              className="bot-close"
              onClick={resetLayout}
              title="Reset Pip's size and position"
            >
              ⤢
            </button>
            <button className="bot-close" onClick={() => setOpen(false)} title="Close">
              ×
            </button>
          </div>
          <div className="bot-msgs">
            {demo ? (
              // The whole reason Pip is on a demo canvas: the researched
              // explanation for the shape the student is looking at.
              <TopologyExplainer demo={demo} />
            ) : allDone ? (
              <div className="bot-msg">{signOff()}</div>
            ) : (
              <>
                <div className="bot-msg">
                  {opener ?? 'Ask me for a hint when you get stuck. I guide, I don’t solve.'}
                </div>
                {lab.hints.slice(0, hintLevel).map((h) => (
                  <div className="bot-msg" key={h.level}>
                    <strong style={{ color: 'var(--brand-cyan-soft)' }}>Hint {h.level}:</strong>{' '}
                    {h.text}
                  </div>
                ))}
              </>
            )}
          </div>
          {!demo && !allDone && lab.hints.length > 0 && (
            <div className="bot-actions">
              <button className="btn primary" onClick={revealNext} disabled={hintLevel >= lab.hints.length}>
                {hintLevel === 0
                  ? 'Give me a nudge'
                  : hintLevel >= lab.hints.length
                    ? 'No more hints'
                    : 'I need more help'}
              </button>
            </div>
          )}
          {/* Resize grips, last in the drawer so they sit over what they overlap. */}
          <div
            className="bot-grip bot-grip-tl"
            title="Drag to resize the panel"
            onPointerDown={(e) => onGripPointerDown(e, 'tl')}
            onPointerMove={onGripPointerMove}
            onPointerUp={onGripPointerUp}
            onPointerCancel={onGripPointerUp}
          />
          <div
            className="bot-grip bot-grip-x"
            title="Drag to set the panel width"
            onPointerDown={(e) => onGripPointerDown(e, 'x')}
            onPointerMove={onGripPointerMove}
            onPointerUp={onGripPointerUp}
            onPointerCancel={onGripPointerUp}
          />
          <div
            className="bot-grip bot-grip-y"
            title="Drag to set the panel height"
            onPointerDown={(e) => onGripPointerDown(e, 'y')}
            onPointerMove={onGripPointerMove}
            onPointerUp={onGripPointerUp}
            onPointerCancel={onGripPointerUp}
          />
          <div
            className="bot-grip bot-grip-br"
            title="Drag to resize the panel"
            onPointerDown={(e) => onGripPointerDown(e, 'br')}
            onPointerMove={onGripPointerMove}
            onPointerUp={onGripPointerUp}
            onPointerCancel={onGripPointerUp}
          />
        </div>
      )}
    </div>
  );
}
