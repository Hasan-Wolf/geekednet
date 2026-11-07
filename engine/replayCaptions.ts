/**
 * A replay's notes, as a subtitle track.
 *
 * Every step already carries a `note` — the author's aside, written for whoever
 * reads the JSON — and a duration it occupies on screen. Those two facts are a
 * timed script, so the captions for a recorded clip are not something to write:
 * they are something to read out of the replay that produced it.
 *
 * Why this matters more than it sounds: a recorded lab is watched on a phone,
 * usually on mute. A clip with no captions is a clip of boxes changing colour.
 *
 * ### On timing, and on not inventing it
 *
 * This reads only the numbers a replay actually carries: a `wait` step's `ms`,
 * and a paced step's own `settleMs`. It deliberately does **not** fall back to
 * the runner's `DEFAULT_SETTLE_MS`, which lives in `src/replay.ts` because, as
 * that module puts it, the engine has no opinion on how long a human needs. A
 * step with no `settleMs` is therefore an error here rather than a guess —
 * `captionFallback` exists for the caller that does hold those defaults and
 * wants to pass them in.
 *
 * Guessing would produce a caption track that is subtly wrong, and the symptom
 * is subtitles drifting out of sync a few steps into a finished video — a fault
 * nobody notices until the clip has shipped. Replays from
 * {@link ./replayGenerator.ts} always carry explicit `settleMs`, so they need no
 * fallback at all.
 */

import type { Replay, ReplayStep, ReplayStepType } from './replay.js';

/** Thrown when a replay does not carry the timing a caption track needs. */
export class CaptionTimingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptionTimingError';
  }
}

/** One line of narration, and the span of the clip it belongs to. */
export interface Caption {
  /** 1-based, in play order — the cue number both SRT and VTT want. */
  index: number;
  /** Milliseconds from the start of the clip. */
  startMs: number;
  endMs: number;
  text: string;
}

export interface CaptionTrack {
  captions: Caption[];
  /** Total running time of the replay in ms — the length of the clip. */
  durationMs: number;
}

export interface CaptionOptions {
  /**
   * Holds to assume for a paced step that carries no `settleMs` of its own.
   *
   * The caller that has the runner's defaults passes them here; without it, such
   * a step is a {@link CaptionTimingError}. See this module's header.
   */
  captionFallback?: Partial<Record<ReplayStepType, number>>;
}

/** How long `step` occupies the clip, from what it actually carries. */
function holdFor(step: ReplayStep, where: string, fallback: CaptionOptions['captionFallback']): number {
  if (step.type === 'wait') return step.ms;
  if (step.settleMs !== undefined) return step.settleMs;
  const assumed = fallback?.[step.type];
  if (assumed !== undefined) return assumed;
  throw new CaptionTimingError(
    `${where}: a ${step.type} step carries no settleMs, and no captionFallback was given for it — ` +
      'captions cannot be timed against a duration that is not in the replay',
  );
}

/**
 * The narration track for `replay`: one caption per step that has a note, timed
 * to the span that step is on screen.
 *
 * Steps without a note still advance the clock — a silent beat is part of the
 * pacing, and swallowing it would shift every caption after it earlier.
 */
export function replayCaptions(replay: Replay, options: CaptionOptions = {}): CaptionTrack {
  const captions: Caption[] = [];
  let clock = 0;
  replay.steps.forEach((step, index) => {
    const hold = holdFor(step, `replay ${replay.id} step #${index}`, options.captionFallback);
    const text = step.note?.trim();
    if (text) {
      captions.push({ index: captions.length + 1, startMs: clock, endMs: clock + hold, text });
    }
    clock += hold;
  });
  return { captions, durationMs: clock };
}

/** `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (WebVTT). */
function stamp(ms: number, separator: ',' | '.'): string {
  const whole = Math.max(0, Math.round(ms));
  const hours = Math.floor(whole / 3_600_000);
  const minutes = Math.floor((whole % 3_600_000) / 60_000);
  const seconds = Math.floor((whole % 60_000) / 1000);
  const millis = whole % 1000;
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${pad(millis, 3)}`;
}

/** The track as an SRT file — what video editors and most upload flows accept. */
export function toSrt(track: CaptionTrack): string {
  return track.captions
    .map(
      (cue) =>
        `${cue.index}\n${stamp(cue.startMs, ',')} --> ${stamp(cue.endMs, ',')}\n${cue.text}\n`,
    )
    .join('\n');
}

/** The track as WebVTT — what an HTML5 `<track>` element wants. */
export function toVtt(track: CaptionTrack): string {
  const cues = track.captions.map(
    (cue) => `${cue.index}\n${stamp(cue.startMs, '.')} --> ${stamp(cue.endMs, '.')}\n${cue.text}\n`,
  );
  return `WEBVTT\n\n${cues.join('\n')}`;
}
