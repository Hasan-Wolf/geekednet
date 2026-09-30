/**
 * Keeping Pip reachable, and keeping Pip a panel.
 *
 * The panel is dragged by its header, which means the header is also the only
 * way to drag it back — so a position that puts the header off the canvas is a
 * panel the student has lost. Now that the student sets the size too, either
 * clamp failing loses the companion: too large and it takes the canvas with it,
 * too small and there is nothing left to read or grab. Both have to hold for a
 * canvas of any size, including one smaller than Pip.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_POS,
  DEFAULT_SIZE,
  MAX_SIZE,
  MIN_SIZE,
  clampPos,
  clampSize,
  resizeBy,
} from '../components/CompanionBot.js';

/** A roomy canvas and a typical open drawer. */
const CANVAS = { width: 900, height: 600 };
const PANEL = { width: 320, height: 200 };

const clamp = (right: number, bottom: number, winOpen = false) =>
  clampPos({ right, bottom }, PANEL, CANVAS, winOpen);

describe('clampPos', () => {
  it('leaves a position that is already comfortably inside alone', () => {
    expect(clamp(200, 150)).toEqual({ right: 200, bottom: 150 });
    expect(clampPos(DEFAULT_POS, PANEL, CANVAS, false)).toEqual(DEFAULT_POS);
  });

  it('stops the panel sliding off the near edges', () => {
    // Dragged hard into the bottom-right corner and beyond.
    expect(clamp(-500, -500)).toEqual({ right: 8, bottom: 8 });
  });

  it('stops the panel sliding off the far edges', () => {
    // Fully inside, not merely peeking: 900 - 320 - 8 and 600 - 200 - 8.
    expect(clamp(5000, 5000)).toEqual({ right: 572, bottom: 392 });
  });

  it('keeps the whole panel on the canvas, not just a sliver', () => {
    const { right, bottom } = clamp(5000, 5000);
    expect(right + PANEL.width).toBeLessThanOrEqual(CANVAS.width);
    expect(bottom + PANEL.height).toBeLessThanOrEqual(CANVAS.height);
  });

  it('collapses to the near edge when the canvas is smaller than the panel', () => {
    // Nothing can be fully inside here; the clamp must not invert and fling the
    // panel out the other side.
    const tiny = { width: 120, height: 90 };
    for (const [right, bottom] of [[-99, -99], [0, 0], [999, 999]]) {
      const pos = clampPos({ right, bottom }, PANEL, tiny, false);
      expect(pos).toEqual({ right: 8, bottom: 8 });
    }
  });

  it('lifts the panel clear of the win bar while it is up', () => {
    expect(clamp(200, 10, true)).toEqual({ right: 200, bottom: 84 });
    // Already above the bar, so nothing moves.
    expect(clamp(200, 300, true)).toEqual({ right: 200, bottom: 300 });
  });

  it('does not lift it past the top of the canvas to clear the bar', () => {
    const shallow = { width: 900, height: 200 };
    const pos = clampPos({ right: 20, bottom: 0 }, PANEL, shallow, true);
    // The bar clearance wins over the far-edge cap rather than producing a
    // negative box, and the panel stays put at that floor.
    expect(pos.bottom).toBe(84);
    expect(pos.right).toBe(20);
  });

  it('is idempotent — settling an already-settled position changes nothing', () => {
    for (const [right, bottom] of [[-50, -50], [5000, 5000], [200, 150]]) {
      const once = clampPos({ right, bottom }, PANEL, CANVAS, false);
      expect(clampPos(once, PANEL, CANVAS, false)).toEqual(once);
    }
  });
});

describe('resizeBy', () => {
  /** The panel at its default, mid-drag. */
  const from = { width: 260, height: 320 };

  it('grows from the bottom-right corner when the pointer travels out from it', () => {
    // That corner is pinned by the anchor, so "out" is down and to the right and
    // the corner itself does not move — the room opens on the far side.
    expect(resizeBy('br', from, 40, 30)).toEqual({ width: 300, height: 350 });
    expect(resizeBy('br', from, -40, -30)).toEqual({ width: 220, height: 290 });
  });

  it('grows from the top-left corner when the pointer travels out from it', () => {
    // The free corner: the panel opens up and to the left, and this corner is
    // the one that goes there, so it tracks the pointer instead of staying put.
    expect(resizeBy('tl', from, -40, -30)).toEqual({ width: 300, height: 350 });
    expect(resizeBy('tl', from, 40, 30)).toEqual({ width: 220, height: 290 });
  });

  it('mirrors the two corners — the same travel, opposite senses', () => {
    expect(resizeBy('tl', from, -25, -25)).toEqual(resizeBy('br', from, 25, 25));
    expect(resizeBy('tl', from, 25, 25)).toEqual(resizeBy('br', from, -25, -25));
  });

  it('holds the other axis still for an edge grip', () => {
    expect(resizeBy('x', from, 40, 999)).toEqual({ width: 300, height: 320 });
    expect(resizeBy('y', from, 999, 30)).toEqual({ width: 260, height: 350 });
  });

  it('leaves the size alone when the pointer has not moved', () => {
    for (const axis of ['x', 'y', 'br', 'tl'] as const) {
      expect(resizeBy(axis, from, 0, 0)).toEqual(from);
    }
  });
});

describe('clampSize', () => {
  /** Roomy enough that the flat maximum, not the canvas share, is the ceiling. */
  const ROOMY = { width: 1600, height: 1200 };
  /** Tight enough that the share binds first in both directions. */
  const SNUG = { width: 700, height: 520 };

  it('leaves the default alone on a canvas with room for it', () => {
    expect(clampSize(DEFAULT_SIZE, CANVAS)).toEqual(DEFAULT_SIZE);
    expect(clampSize({ width: 380, height: 260 }, CANVAS)).toEqual({ width: 380, height: 260 });
  });

  it('will not let the panel be shrunk past readable', () => {
    expect(clampSize({ width: 0, height: 0 }, CANVAS)).toEqual(MIN_SIZE);
    expect(clampSize({ width: -900, height: -900 }, CANVAS)).toEqual(MIN_SIZE);
  });

  it('caps an unbounded drag at the flat maximum', () => {
    expect(clampSize({ width: 9000, height: 9000 }, ROOMY)).toEqual(MAX_SIZE);
  });

  it('keeps the whole companion to a share of the canvas it sits on', () => {
    // A drag to the far edge on a smallish canvas: three-quarters of 700 and of
    // 520, the orb's 58px strip coming off the width.
    const grown = clampSize({ width: 9000, height: 9000 }, SNUG);
    expect(grown).toEqual({ width: 467, height: 390 });
    // Which is the point of the cap — the network is still the thing on screen.
    expect(grown.width + 58).toBeLessThan(SNUG.width);
    expect(grown.height).toBeLessThan(SNUG.height);
  });

  it('takes whichever ceiling is lower, per axis', () => {
    // On this canvas the flat maximum binds the width (560 under the share's 617)
    // while the share binds the height (450 under the flat 620).
    expect(clampSize({ width: 9000, height: 9000 }, CANVAS)).toEqual({
      width: MAX_SIZE.width,
      height: 450,
    });
  });

  it('falls back to the minimum on a canvas too small for it', () => {
    // Nothing fits here. The floor wins over the share rather than inverting
    // into a negative box; clampPos then parks the oversized panel at the edge.
    const tiny = { width: 200, height: 160 };
    expect(clampSize({ width: 300, height: 300 }, tiny)).toEqual(MIN_SIZE);
    expect(clampSize({ width: 10, height: 10 }, tiny)).toEqual(MIN_SIZE);
  });

  it('clamps each axis on its own', () => {
    // Too wide for this canvas, but a height it can carry — only the width moves.
    expect(clampSize({ width: 9000, height: 220 }, SNUG)).toEqual({ width: 467, height: 220 });
    // And the other way about.
    expect(clampSize({ width: 300, height: 9000 }, SNUG)).toEqual({ width: 300, height: 390 });
  });

  it('is idempotent — settling an already-settled size changes nothing', () => {
    const canvases = [CANVAS, ROOMY, SNUG, { width: 200, height: 160 }];
    const sizes = [
      { width: 9000, height: 9000 },
      { width: 0, height: 0 },
      DEFAULT_SIZE,
    ];
    for (const canvas of canvases) {
      for (const size of sizes) {
        const once = clampSize(size, canvas);
        expect(clampSize(once, canvas)).toEqual(once);
      }
    }
  });
});
