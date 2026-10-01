/** App shell: topbar (logo · phase tabs · lab selector · XP) and the three-column
 *  stage (palette · canvas · side). Lab completion is announced by the win bar,
 *  which lives inside the canvas column — see components/WinBar.
 *
 *  Below 900px none of that renders: {@link App} hands the screen to the stacked
 *  read-only phone layout instead (see phone/PhoneApp). The two are separate
 *  trees rather than one tree restyled, so the desktop stage — its components,
 *  its resizers, its behaviour — is exactly what it was above the breakpoint. */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import { useStore, tierPhase } from './store.js';
import { useMissionProgress } from './progress.js';
import { Palette } from './components/Palette.js';
import { Canvas } from './components/Canvas.js';
import { ConfigPanel } from './components/ConfigPanel.js';
import { Objectives } from './components/Objectives.js';
import { TopologyPanel } from './components/Topology.js';
import { Terminal } from './components/Terminal.js';
import { PhoneApp } from './phone/PhoneApp.js';
import { useIsPhone } from './phone/usePhoneLayout.js';

const PHASES = [
  { key: 'setup', label: 'Setup', color: 'var(--phase-setup)' },
  { key: 'build', label: 'Build', color: 'var(--phase-build)' },
  { key: 'defend', label: 'Defend', color: 'var(--phase-defend)' },
  { key: 'attack', label: 'Attack', color: 'var(--phase-attack)' },
] as const;

/** The lab selector's stand-in while Learn Topology has the canvas. A demo is
 *  not in the lab registry, so the select has no option of its own to show. */
const TOPOLOGY_OPTION = '__learn-topology';

const LEVEL_SIZE = 300;

// Caption for phase tabs that have no labs behind them yet (Defend, Attack).
const COMING_SOON = 'Coming soon — Tier 2';

// Right-hand config column. The floor keeps the three route fields readable; the
// ceiling keeps the canvas — the thing being taught — the biggest panel on screen.
const SIDE_MIN = 280;
const SIDE_MAX = 640;
const SIDE_DEFAULT = 380;
const SIDE_KEY = 'geekednet.sideWidth';
// Palette rail + the narrowest canvas still worth building on. The ceiling is
// whichever is smaller, so a wide panel can never squeeze the canvas out.
const PALETTE_W = 220;
const CANVAS_MIN = 360;

/** Widest the column may get right now: the configured ceiling, or whatever the
 *  window can spare once the palette and a usable canvas have their share. */
const sideLimit = (): number =>
  Math.max(SIDE_MIN, Math.min(SIDE_MAX, window.innerWidth - PALETTE_W - CANVAS_MIN));

// Terminal height, dragged from its top edge. The floor keeps the prompt and a
// couple of lines of scrollback readable; the ceiling is whatever is left once
// the objectives and config panel above have had their minimum, so neither half
// of the column can be squeezed out of existence by the other.
const TERM_MIN = 140;
const TERM_DEFAULT = 260;
const SIDE_SCROLL_MIN = 170;
const TERM_KEY = 'geekednet.termHeight';

/**
 * Height of the terminal, dragged from its top edge and remembered across
 * sessions — the horizontal twin of {@link useSideWidth}, and guarded the same
 * way against storage that throws.
 *
 * The ceiling is measured from the column itself rather than the window, so it
 * is correct whatever else the layout is doing above it. Changing the terminal
 * height cannot change the column height, so there is no feedback loop here.
 */
function useTerminalHeight(sideRef: RefObject<HTMLDivElement>) {
  const [preferred, setPreferred] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(TERM_KEY));
      return Number.isFinite(saved) && saved > 0 ? Math.round(saved) : TERM_DEFAULT;
    } catch {
      return TERM_DEFAULT;
    }
  });
  const [limit, setLimit] = useState<number>(TERM_DEFAULT);
  const height = Math.min(limit, Math.max(TERM_MIN, preferred));

  /** Tallest the terminal may be right now, leaving the panel above its floor. */
  const ceiling = useCallback(() => {
    const h = sideRef.current?.clientHeight ?? 0;
    return h > 0 ? Math.max(TERM_MIN, h - SIDE_SCROLL_MIN) : Number.POSITIVE_INFINITY;
  }, [sideRef]);

  const apply = useCallback(
    (h: number) => setPreferred(Math.min(ceiling(), Math.max(TERM_MIN, Math.round(h)))),
    [ceiling],
  );

  /**
   * Move by a delta rather than to an absolute height.
   *
   * Keyboard steps have to read the *previous* value inside the updater: two
   * presses in one React batch both see the same stale `height` from the render
   * that bound the handler, and the second would undo the first.
   */
  const nudge = useCallback(
    (delta: number) =>
      setPreferred((prev) => {
        const max = ceiling();
        const current = Math.min(max, Math.max(TERM_MIN, prev));
        return Math.min(max, Math.max(TERM_MIN, Math.round(current + delta)));
      }),
    [ceiling],
  );

  const drag = useRef<{ startY: number; startHeight: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      drag.current = { startY: e.clientY, startHeight: height };
      setDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [height],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d) return;
      // Dragging up grows the terminal, so the delta is inverted.
      apply(d.startHeight - (e.clientY - d.startY));
    },
    [apply],
  );

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, []);

  // Written once the handle is let go, so a drag doesn't churn storage per frame.
  useEffect(() => {
    if (dragging) return;
    try {
      localStorage.setItem(TERM_KEY, String(preferred));
    } catch {
      /* storage unavailable — the height just won't survive a reload */
    }
  }, [preferred, dragging]);

  // A shorter window squeezes the rendered height without overwriting the one
  // the player chose, so it springs back when there is room again.
  useEffect(() => {
    const el = sideRef.current;
    if (!el) return;
    const recompute = () => setLimit(ceiling());
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sideRef, ceiling]);

  useEffect(() => {
    if (!dragging) return;
    document.body.classList.add('resizing-term');
    return () => document.body.classList.remove('resizing-term');
  }, [dragging]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 40 : 12;
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        nudge(step);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        nudge(-step);
      }
    },
    [nudge],
  );

  return { height, limit, dragging, onPointerDown, onPointerMove, endDrag, onKeyDown };
}

/** Width of the side column, dragged from its left edge and remembered across
 *  sessions. Storage can throw (private mode, blocked site data), so every access
 *  is guarded and simply falls back to the default width. */
function useSideWidth() {
  // What the player asked for, and what the window can currently allow, are kept
  // apart on purpose: a temporarily narrow window squeezes the rendered column
  // without overwriting the width they chose.
  const [preferred, setPreferred] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(SIDE_KEY));
      return Number.isFinite(saved) && saved > 0 ? Math.round(saved) : SIDE_DEFAULT;
    } catch {
      return SIDE_DEFAULT;
    }
  });
  const [limit, setLimit] = useState<number>(sideLimit);
  const width = Math.min(limit, Math.max(SIDE_MIN, preferred));

  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const apply = useCallback(
    (w: number) => setPreferred(Math.min(sideLimit(), Math.max(SIDE_MIN, Math.round(w)))),
    [],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      drag.current = { startX: e.clientX, startWidth: width };
      setDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [width],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d) return;
      // Dragging left widens the panel, so the delta is inverted.
      apply(d.startWidth - (e.clientX - d.startX));
    },
    [apply],
  );

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }, []);

  // Written once the handle is let go, so a drag doesn't churn storage per frame.
  useEffect(() => {
    if (dragging) return;
    try {
      localStorage.setItem(SIDE_KEY, String(preferred));
    } catch {
      /* storage unavailable — the width just won't survive a reload */
    }
  }, [preferred, dragging]);

  // The window can shrink under a stored width; re-read the ceiling, never the
  // preference, so the column springs back when there is room again. Observed on
  // the root element rather than window.resize, which some embedded/automated
  // viewports never fire.
  useEffect(() => {
    const ro = new ResizeObserver(() => setLimit(sideLimit()));
    ro.observe(document.documentElement);
    return () => ro.disconnect();
  }, []);

  // The pointer routinely leaves the 9px handle mid-drag; hold the resize cursor
  // on the whole document until the drag ends.
  useEffect(() => {
    if (!dragging) return;
    document.body.classList.add('resizing-side');
    return () => document.body.classList.remove('resizing-side');
  }, [dragging]);

  // Keyboard equivalent of the drag, so the panel isn't pointer-only.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 40 : 12;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        apply(width + step);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        apply(width - step);
      }
    },
    [apply, width],
  );

  return { width, dragging, onPointerDown, onPointerMove, endDrag, onKeyDown };
}

/**
 * Which layout the screen gets.
 *
 * The only thing shared across the breakpoint is the store, so nothing about the
 * phone layout can reach the desktop one: below 900px `DesktopApp` is not
 * mounted, and at or above it no phone component exists in the tree at all.
 */
export function App() {
  return useIsPhone() ? <PhoneApp /> : <DesktopApp />;
}

function DesktopApp() {
  const labs = useStore((s) => s.labs);
  const activeLabId = useStore((s) => s.activeLabId);
  const activeLab = labs.find((l) => l.id === activeLabId)!;
  const unlocked = useStore((s) => s.unlocked);
  const completedLabs = useStore((s) => s.completedLabs);
  const xp = useStore((s) => s.xp);
  const loadLab = useStore((s) => s.loadLab);
  const side = useSideWidth();
  const sideRef = useRef<HTMLDivElement>(null);
  const term = useTerminalHeight(sideRef);
  // Kept in the store rather than here: the win bar opens the same dialog from
  // inside the canvas column, and the dialog itself must render outside the
  // topbar (see ResetConfirm).
  const confirmReset = useStore((s) => s.resetConfirmOpen);
  const setConfirmReset = useStore((s) => s.setResetConfirm);
  const topologyMode = useStore((s) => s.topologyMode);
  const enterTopologyMode = useStore((s) => s.enterTopologyMode);

  // While Learn Topology has the canvas, no lab is on it — so no phase tab is
  // the active one either, and the topology tab carries the active styling.
  const activePhase = topologyMode ? null : tierPhase(activeLab.tier);
  const level = Math.floor(xp / LEVEL_SIZE) + 1;
  const fill = ((xp % LEVEL_SIZE) / LEVEL_SIZE) * 100;

  const phaseHasLabs = (key: string): boolean =>
    labs.some((l) => tierPhase(l.tier) === key);

  const phaseUnlocked = (key: string): boolean =>
    labs.some((l) => tierPhase(l.tier) === key && unlocked.includes(l.id));

  const jumpToPhase = (key: string) => {
    const target = labs.find((l) => tierPhase(l.tier) === key && unlocked.includes(l.id));
    if (target) loadLab(target.id);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="logo">
          Geeked<span className="spark">Net</span>
        </div>
        <div className="tabs">
          {PHASES.map((p) => {
            // Two different kinds of "you can't go here". `locked` means the phase
            // has labs you haven't earned yet; `unbuilt` means it has no labs at
            // all, so a padlock on its own would promise something that isn't there.
            // Derived from the lab set, so registering a tier-4 lab flips the tab
            // back to normal progress-locking without touching this component.
            const unbuilt = !phaseHasLabs(p.key);
            const isUnlocked = !unbuilt && phaseUnlocked(p.key);
            const active = p.key === activePhase;
            return (
              <button
                key={p.key}
                className={`tab${active ? ' active' : ''}${isUnlocked ? '' : ' locked'}${unbuilt ? ' unbuilt' : ''}`}
                style={
                  unbuilt
                    ? undefined
                    : active
                      ? { background: hexToRgba(p.color), borderColor: 'transparent', color: '#fff' }
                      : { borderColor: p.color, color: 'var(--text-muted)' }
                }
                disabled={!isUnlocked}
                aria-disabled={!isUnlocked}
                // The visible label sits in a nested span, which some AX trees skip;
                // name the button outright so screen readers get the phase and why
                // it can't be opened.
                aria-label={unbuilt ? `${p.label}: ${COMING_SOON}` : p.label}
                onClick={() => isUnlocked && jumpToPhase(p.key)}
              >
                {unbuilt ? (
                  <span className="lock" aria-hidden="true">
                    🔒
                  </span>
                ) : (
                  <span className="dot" style={{ background: p.color, boxShadow: `0 0 8px ${p.color}` }} />
                )}
                <span className="tab-text">
                  {p.label}
                  {unbuilt && <span className="tab-soon">{COMING_SOON}</span>}
                </span>
                {!unbuilt && !isUnlocked && ' 🔒'}
              </button>
            );
          })}

          {/* Learn Topology sits beside the four campaign phases but is not one
              of them: it has nothing to unlock and nothing to score, so it is
              always available. The brand gradient says "open" where the phase
              colors would have said something about network status. */}
          <button
            className={`tab tab-topology${topologyMode ? ' active' : ''}`}
            onClick={enterTopologyMode}
            aria-label="Learn Topology"
            aria-pressed={topologyMode}
          >
            <span className="dot topo-dot" />
            <span className="tab-text">Learn Topology</span>
          </button>
        </div>

        <div className="spacer" />

        <select
          className="btn"
          value={topologyMode ? TOPOLOGY_OPTION : activeLabId}
          onChange={(e) => {
            if (e.target.value !== TOPOLOGY_OPTION) loadLab(e.target.value);
          }}
          style={{ maxWidth: 240 }}
        >
          {/* Only while it is the answer: a demo is not something you pick from
              the lab list, it is what the list is currently not showing. */}
          {topologyMode && (
            <option value={TOPOLOGY_OPTION} disabled>
              ◇ Learn Topology
            </option>
          )}
          {labs.map((l) => {
            const locked = !unlocked.includes(l.id);
            const done = completedLabs.includes(l.id);
            return (
              <option key={l.id} value={l.id} disabled={locked}>
                {locked ? '🔒 ' : done ? '✓ ' : ''}
                {l.title} {l.mode !== 'learn' && l.id !== 'sandbox' ? `(${l.mode})` : ''}
              </option>
            );
          })}
        </select>

        <NextLabChip />

        <div className="xp">
          <span className="lvl">LV {level}</span>
          <div className="xpbar">
            <div className="xpfill" style={{ width: `${fill}%` }} />
          </div>
        </div>

        <SettingsMenu onResetProgress={() => setConfirmReset(true)} />
      </header>

      <div
        className="stage"
        style={
          { '--side-w': `${side.width}px`, '--term-h': `${term.height}px` } as CSSProperties
        }
      >
        <Palette />
        <Canvas />
        <div className="side" ref={sideRef}>
          <div
            className={`side-resizer${side.dragging ? ' dragging' : ''}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize configuration panel"
            aria-valuenow={side.width}
            aria-valuemin={SIDE_MIN}
            aria-valuemax={SIDE_MAX}
            tabIndex={0}
            onPointerDown={side.onPointerDown}
            onPointerMove={side.onPointerMove}
            onPointerUp={side.endDrag}
            onPointerCancel={side.endDrag}
            onKeyDown={side.onKeyDown}
          />
          <div className="side-scroll" style={{ flex: 1 }}>
            {/* A demo has no objectives to list, so the panel that would show
                them carries the shape instead. The config panel below is
                unchanged: a topology is edited with exactly the lab controls. */}
            {topologyMode ? <TopologyPanel /> : <Objectives />}
            <ConfigPanel />
          </div>
          <div
            className={`term-resizer${term.dragging ? ' dragging' : ''}`}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize terminal"
            aria-valuenow={term.height}
            aria-valuemin={TERM_MIN}
            aria-valuemax={Number.isFinite(term.limit) ? term.limit : undefined}
            tabIndex={0}
            onPointerDown={term.onPointerDown}
            onPointerMove={term.onPointerMove}
            onPointerUp={term.endDrag}
            onPointerCancel={term.endDrag}
            onKeyDown={term.onKeyDown}
          />
          <Terminal />
        </div>
      </div>

      {/* At the app root, above the win bar in z-order, so "Play again" can
          raise it over the open bar. */}
      {confirmReset && <ResetConfirm onClose={() => setConfirmReset(false)} />}
    </div>
  );
}

/** Topbar overflow menu. Resetting progress is destructive and rarely wanted, so
 *  it is tucked behind this rather than sitting a stray click away from the
 *  mission controls. */
function SettingsMenu({ onResetProgress }: { onResetProgress: () => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // Click-away and Escape, bound only while the menu is actually open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="menu-wrap" ref={wrap}>
      <button
        className={`icon-btn${open ? ' active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Settings"
        title="Settings"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <button
            className="menu-item danger"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onResetProgress();
            }}
          >
            ↻ Reset progress…
          </button>
        </div>
      )}
    </div>
  );
}

/** Confirm step for the one action that can't be undone. Rendered at the app
 *  root, not in the topbar: the topbar's backdrop-filter would make it the
 *  containing block for a fixed-position child and trap the backdrop inside it. */
function ResetConfirm({ onClose }: { onClose: () => void }) {
  const resetProgress = useStore((s) => s.resetProgress);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Cancel is the default action: it takes focus on open, so Return dismisses
  // rather than wipes, and Escape does the same.
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="confirm-backdrop" onClick={onClose}>
      <div
        className="confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="confirm-title" id="confirm-title">
          Reset progress?
        </h2>
        <p className="confirm-body" id="confirm-body">
          This clears all completed labs, XP, and badges. You'll start again from the
          first lab. This can't be undone.
        </p>
        <div className="confirm-actions">
          <button className="btn" ref={cancelRef} onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn danger"
            onClick={() => {
              resetProgress();
              onClose();
            }}
          >
            Reset progress
          </button>
        </div>
      </div>
    </div>
  );
}

/** Mission counter plus a shortcut to whatever comes next. Always rendered — it
 *  swaps its own text when the campaign is finished rather than unmounting, so
 *  the topbar never reflows around it. */
function NextLabChip() {
  const { completed, total, next, nextLocked, allComplete } = useMissionProgress();
  const activeLabId = useStore((s) => s.activeLabId);
  const loadLab = useStore((s) => s.loadLab);

  // Loading a lab resets its canvas, so the chip stays inert when it points at
  // the lab already on screen — it reads as a status line there, not a trap.
  const isCurrent = !!next && next.id === activeLabId;
  const canJump = !!next && !nextLocked && !isCurrent;

  const label = allComplete || !next ? 'All labs complete' : `Next → ${next.title}`;

  return (
    <button
      className={`next-chip${canJump ? '' : ' inert'}${allComplete ? ' done' : ''}`}
      onClick={() => canJump && loadLab(next.id)}
      disabled={!canJump}
      title={canJump ? `Switch to ${next.title}` : label}
      aria-label={
        allComplete || !next
          ? `${completed} of ${total} labs complete`
          : `${completed} of ${total} labs complete. Next lab: ${next.title}`
      }
    >
      <span className="nc-count">
        {completed} / {total}
      </span>
      <span className="nc-sep" aria-hidden="true">
        ·
      </span>
      <span className="nc-label">{label}</span>
    </button>
  );
}

function hexToRgba(color: string): string {
  // The phase colors arrive as CSS vars in some call sites; for the active tab we
  // just want a translucent wash, so fall back to a soft cyan-ish tint.
  return color.startsWith('#') ? `${color}26` : 'rgba(34,211,238,0.15)';
}
