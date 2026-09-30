/**
 * Win bar — what a completed mission looks like now.
 *
 * It is a bar across the bottom of the canvas, not a full-screen cut-in: the
 * network the student just built stays visible and clickable above it, with the
 * verified path still pulsing behind. The anime energy survives in the treatment
 * — the slam word still drops letter by letter with its chromatic ghosts — but at
 * bar scale, and it never takes the canvas away.
 *
 * Rendered inside `.canvas-wrap` (see Canvas), so "bottom" means the bottom of
 * the canvas rather than the bottom of the window.
 */
import { type CSSProperties } from 'react';
import { useStore, tierPhase } from '../store.js';
import { useMissionProgress } from '../progress.js';

// English-only slam word per phase — the anime energy is in the treatment, not
// the language: CONNECTED on setup/build, DEFENDED on firewall labs, BREACHED
// on attack labs.
const SLAM_WORDS: Record<ReturnType<typeof tierPhase>, string> = {
  setup: 'CONNECTED',
  build: 'CONNECTED',
  defend: 'DEFENDED',
  attack: 'BREACHED',
};

/** How far behind each other the letters drop. Tighter than the old full-screen
 *  cut-in so the word has settled about when the bar finishes sliding up; the
 *  drop itself is timed in CSS (`.win-letter`). */
const STAGGER_MS = 40;

/** A space in a slam word would collapse to a zero-width inline-block; give it
 *  something to occupy. Today's words have none — this is so adding one later
 *  doesn't quietly break the spacing. */
const glyph = (ch: string): string => (ch === ' ' ? '\u00a0' : ch);

export function WinBar() {
  const justCompleted = useStore((s) => s.justCompleted);
  const lab = useStore((s) => s.labs.find((l) => l.id === s.justCompleted) ?? null);
  const dismiss = useStore((s) => s.dismissCompletion);
  const loadLab = useStore((s) => s.loadLab);
  const openReset = useStore((s) => s.setResetConfirm);
  // Same source of truth as the topbar chip, so the two always name the same lab.
  const { next, nextLocked, allComplete } = useMissionProgress();

  if (!justCompleted || !lab) return null;

  const word = SLAM_WORDS[tierPhase(lab.tier)];
  const badges = lab.rewards.badges?.length
    ? lab.rewards.badges.map((b) => b.replace(/-/g, ' ')).join(' · ')
    : null;

  return (
    <div className="win-bar" role="status" aria-label={`${word}. ${lab.title} complete.`}>
      {/* Split per letter so each one drops on its own beat. The letters are
          decorative at this point — the word is named on the bar itself above,
          so a screen reader reads it once rather than nine times. */}
      <div className="win-word" aria-hidden="true">
        {word.split('').map((ch, i) => (
          // --ld drives the drop and both chromatic ghosts, so the cyan and
          // magenta shear off each letter as it lands rather than off the word
          // as a whole.
          <span key={i} className="win-letter" style={{ '--ld': `${i * STAGGER_MS}ms` } as CSSProperties}>
            <span className="cl">{glyph(ch)}</span>
            <span className="cr">{glyph(ch)}</span>
            <span className="cc">{glyph(ch)}</span>
          </span>
        ))}
      </div>

      <div className="win-meta">
        <div className="win-sub">{lab.title}</div>
        <div className="win-xp">
          +{lab.rewards.xp} XP{badges ? ` · ${badges}` : ''}
        </div>
      </div>

      <div className="spacer" />

      {next && !nextLocked ? (
        <button className="win-next" aria-label={`Next lab: ${next.title}`} onClick={() => loadLab(next.id)}>
          Next → {next.title}
        </button>
      ) : (
        // Either the campaign is over, or the next lab exists but isn't unlocked
        // — state it rather than offering a button that can't work.
        <span className="win-next done">{next ? `Next → ${next.title}` : 'All labs complete'}</span>
      )}

      {/* Finishing the last lab is when replaying is on someone's mind, so the
          offer lives here — but it is the same destructive wipe as the topbar
          item, so it goes through the same confirm. */}
      {allComplete && (
        <button className="win-replay" onClick={() => openReset(true)}>
          ↻ Play again
        </button>
      )}

      <button className="win-x" aria-label="Dismiss" title="Dismiss" onClick={dismiss}>
        ✕
      </button>
    </div>
  );
}
