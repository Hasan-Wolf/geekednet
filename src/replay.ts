/**
 * Replay mode — the app playing a lab through itself.
 *
 * Open the app at `?lab=<labId>&replay=<replayId>` and it loads that lab and
 * then executes the replay's steps, in order, pacing itself so the result is
 * watchable. `scripts/record.ts` points a browser at exactly that URL and films
 * the window.
 *
 * This file is the dispatch half of replay mode; the schema half is
 * `engine/replay.ts`, which owns the step types, validates them, and holds the
 * reasoning for why a step names lab ids rather than selectors. The split is the
 * usual one in this codebase: the engine knows what a replay *is*, the UI layer
 * knows how to make one happen.
 *
 * The rule that matters here is that a step reaches the canvas through the same
 * store action the UI binds to its own inputs, and through no other path:
 *
 *   - `configure`  → `selectDevice` + `setIfaceField` / `setGateway` / `setPower`,
 *                    which is the config panel's own onChange.
 *   - `addRoute`   → `addRoute` + `updateRoute` ×3, which is "+ Add route" and
 *                    then filling the three columns.
 *   - `runPacket`  → `runTerminal('ping <ip>')`, which is the terminal's Return
 *                    key. That goes to `runCommand` → the engine's `ping` →
 *                    `simulatePacket` in both directions, and the result is
 *                    handed to `animatePath` like any other ping. There is no
 *                    second way for a packet to cross the canvas, so a recorded
 *                    run is pixel-for-pixel the run a student gets.
 *
 * `highlight` is the one step with no student gesture behind it; it sets a class
 * on an objective the panel already renders, and nothing else.
 */

import { useEffect } from 'react';
import {
  generateReplay,
  getDevice,
  getReplay,
  replayCaptions,
  runPacketTarget,
  toSrt,
  validateReplay,
  validateReplayAgainstLab,
  type Lab,
  type Replay,
  type ReplayStep,
  type ReplayStepType,
} from '../engine/index.js';
import { ALL_LABS, useStore } from './store.js';

export const LAB_PARAM = 'lab';
export const REPLAY_PARAM = 'replay';

/**
 * `?replay=auto` — derive the walkthrough from the lab rather than naming a
 * stored one.
 *
 * Every lab's objectives already state what solved means, so the walkthrough for
 * one is derivable (see engine/replayGenerator.ts). This is how that reaches the
 * recorder: `npm run record -- --lab <id> --replay auto` films a lab that has no
 * hand-written replay JSON, and never needs one.
 *
 * A reserved id rather than a separate parameter, so nothing downstream has to
 * learn a new shape — `?lab=&replay=` is still the whole interface, and the
 * recorder passes it through untouched.
 */
export const AUTO_REPLAY = 'auto';

/** Thrown when a replay cannot be started or a step cannot be carried out. */
export class ReplayRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayRunError';
  }
}

// --- Pacing ----------------------------------------------------------------

/**
 * How long to hold after each kind of step, in ms, when the step does not say.
 *
 * Pacing is the only thing in replay mode that is about the video rather than
 * about the network: every state change is synchronous, and these numbers exist
 * so a viewer can read what just happened. They are deliberately here rather
 * than in the engine, which has no opinion on how long a human needs.
 *
 * `runPacket` is the dwell *after* the packet lands — the flight itself is
 * waited out by watching the real animation, not timed.
 */
export const DEFAULT_SETTLE_MS: Record<ReplayStepType, number> = {
  configure: 700,
  addRoute: 1100,
  runPacket: 2400,
  highlight: 900,
  // A `wait` step's own `ms` is its pause; it has no settle of its own.
  wait: 0,
};

/** Beat between the three columns of a route, so it reads as a form being filled. */
const ROUTE_FIELD_BEAT_MS = 260;

/** Longest a packet may be in flight before the runner stops waiting for it. */
const PACKET_TIMEOUT_MS = 12_000;

const realSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

// --- URL parameters --------------------------------------------------------

export interface ReplayRequest {
  /** `?lab=` — the lab to open, or null when only a replay was named. */
  labId: string | null;
  /** `?replay=` — the replay to play, or null for "just open the lab". */
  replayId: string | null;
}

/**
 * Read the replay parameters out of a query string. `null` when neither is
 * present, which is the ordinary way the app opens.
 */
export function readReplayRequest(search: string): ReplayRequest | null {
  const params = new URLSearchParams(search);
  const labId = (params.get(LAB_PARAM) ?? '').trim();
  const replayId = (params.get(REPLAY_PARAM) ?? '').trim();
  if (!labId && !replayId) return null;
  return { labId: labId || null, replayId: replayId || null };
}

/**
 * Turn a request into the lab and replay it names, or throw saying why not.
 *
 * Every failure here is loud on purpose. `loadLab` falls back to the first lab
 * in the registry for an id it doesn't know, which for a recording would mean
 * quietly filming the sandbox instead of the lab that was asked for.
 */
export function resolveReplayRequest(
  request: ReplayRequest,
  labs: Lab[] = ALL_LABS,
): { lab: Lab; replay: Replay | null } {
  // `auto` is derived from the lab, so it cannot be looked up before the lab is
  // known — and it names no lab of its own, which is why it is required to come
  // with one.
  const auto = request.replayId === AUTO_REPLAY;
  const replay = request.replayId && !auto ? findReplay(request.replayId) : null;

  // A replay states the lab it drives, so `?replay=` alone is enough. When both
  // are given they have to agree: whichever one won silently would be wrong half
  // the time, and the recorder names both.
  const labId = request.labId ?? replay?.labId;
  if (!labId) {
    throw new ReplayRunError(
      auto
        ? `?${REPLAY_PARAM}=${AUTO_REPLAY} derives a walkthrough from a lab, ` +
          `so ?${LAB_PARAM}= is required`
        : `?${REPLAY_PARAM}= names no lab and ?${LAB_PARAM}= is missing`,
    );
  }
  if (replay && request.labId && replay.labId !== request.labId) {
    throw new ReplayRunError(
      `replay "${replay.id}" drives lab "${replay.labId}", but ?${LAB_PARAM}=` +
        `"${request.labId}" asks for a different one`,
    );
  }

  const lab = labs.find((l) => l.id === labId);
  if (!lab) {
    throw new ReplayRunError(
      `unknown lab "${labId}" — known labs: ${labs.map((l) => l.id).join(', ')}`,
    );
  }

  // A `ReplayGenerationError` from here is left to propagate: it already names
  // the lab, the objective and the predicate, and the caller's catch puts it on
  // the canvas and into the recorder's status object like any other failure.
  if (auto) return { lab, replay: generateReplay(lab) };

  return { lab, replay };
}

function findReplay(id: string): Replay {
  const replay = getReplay(id);
  if (!replay) throw new ReplayRunError(`unknown replay "${id}"`);
  return replay;
}

// --- The runner ------------------------------------------------------------

export interface ReplayRunOptions {
  /**
   * Scales every pause. `1` is real time; `0` runs the whole replay as fast as
   * the store can apply it, which is what the tests use.
   */
  speed?: number;
  /** Swapped out by tests so a suite doesn't sit through the pacing. */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each step is applied, with its index. */
  onStep?: (index: number, step: ReplayStep) => void;
  /**
   * Something went slower or quieter than expected but the replay carried on —
   * today only "a packet never reported landing". Reported rather than thrown:
   * the state change has already happened by then, and aborting a recording
   * over a missed animation callback would be worse than a short dwell.
   */
  onWarning?: (message: string) => void;
}

interface RunContext {
  pause: (ms: number) => Promise<void>;
  warn: (message: string) => void;
}

/**
 * Play a replay against the live store.
 *
 * Validates first, even though the registry already did: `runReplay` is callable
 * with a replay assembled in code, and the dispatch below relies on the
 * invariants validation establishes (an `interfaceId` where one is needed, a
 * device that exists, a step type that is implemented).
 */
export async function runReplay(replay: Replay, options: ReplayRunOptions = {}): Promise<void> {
  const validated = validateReplay(replay);
  const { lab } = resolveReplayRequest({ labId: validated.labId, replayId: null });
  validateReplayAgainstLab(validated, lab);

  const speed = options.speed ?? 1;
  const sleep = options.sleep ?? realSleep;
  const ctx: RunContext = {
    pause: (ms) => sleep(Math.round(ms * speed)),
    warn: (message) => options.onWarning?.(message),
  };

  for (const [index, step] of validated.steps.entries()) {
    options.onStep?.(index, step);
    await applyStep(step, ctx, `replay ${validated.id} step #${index}`);
    await ctx.pause(holdFor(step));
  }

  // The last highlight has served its purpose by now; leaving it lit would make
  // the final frame look like something is still pending.
  useStore.getState().highlightObjective(null);
}

/** The pause owed after a step: the step's own number, or the default for its type. */
export function holdFor(step: ReplayStep): number {
  if (step.type === 'wait') return step.ms;
  return step.settleMs ?? DEFAULT_SETTLE_MS[step.type];
}

async function applyStep(step: ReplayStep, ctx: RunContext, where: string): Promise<void> {
  switch (step.type) {
    case 'configure':
      return applyConfigure(step, where);

    case 'addRoute':
      return applyAddRoute(step, ctx);

    case 'runPacket':
      return applyRunPacket(step, ctx, where);

    case 'highlight':
      useStore.getState().highlightObjective(step.objectiveId);
      return;

    case 'wait':
      // Nothing to apply — the hold after the step is the step.
      return;

    default: {
      // Unreachable for a validated replay. Thrown rather than ignored for the
      // same reason `checkPredicate` throws on an unknown predicate: a step that
      // silently does nothing still produces a video, and the video looks like
      // the lab failing to solve itself.
      const { type } = step as { type?: unknown };
      throw new ReplayRunError(
        `${where}: no runner for step type ${JSON.stringify(type)} — ` +
          `implemented: ${Object.keys(DEFAULT_SETTLE_MS).join(', ')}`,
      );
    }
  }
}

function applyConfigure(step: Extract<ReplayStep, { type: 'configure' }>, where: string): void {
  const { selectDevice, setIfaceField, setGateway, setPower } = useStore.getState();
  // A student has to click the device before they can type into its panel, and
  // the panel is where the change is visible. So the replay clicks it too.
  selectDevice(step.deviceId);

  if (step.field === 'ip' || step.field === 'mask') {
    const { interfaceId } = step;
    if (!interfaceId) {
      throw new ReplayRunError(
        `${where}: setting "${step.field}" needs an interfaceId naming which interface`,
      );
    }
    setIfaceField(step.deviceId, interfaceId, step.field, step.value);
    return;
  }
  if (step.field === 'gateway') {
    setGateway(step.deviceId, step.value);
    return;
  }
  setPower(step.deviceId, step.value === 'on');
}

async function applyAddRoute(
  step: Extract<ReplayStep, { type: 'addRoute' }>,
  ctx: RunContext,
): Promise<void> {
  const { selectDevice, addRoute, updateRoute } = useStore.getState();
  selectDevice(step.deviceId);
  addRoute(step.deviceId);

  // The row the click just appended. Read back from state rather than assumed,
  // so a lab whose router already ships with routes still gets the new one.
  const routes = getDevice(useStore.getState().network, step.deviceId)?.routes ?? [];
  const index = routes.length - 1;

  for (const field of ['dst', 'mask', 'gateway'] as const) {
    updateRoute(step.deviceId, index, field, step[field]);
    await ctx.pause(ROUTE_FIELD_BEAT_MS);
  }
}

async function applyRunPacket(
  step: Extract<ReplayStep, { type: 'runPacket' }>,
  ctx: RunContext,
  where: string,
): Promise<void> {
  const { network, selectDevice, runTerminal } = useStore.getState();
  const target = runPacketTarget(network, step);
  if (!target) {
    throw new ReplayRunError(
      `${where}: nothing to ping — device "${step.dstDevice}" has no address yet`,
    );
  }

  selectDevice(step.src);
  // Exactly what the terminal does on Return when a device is selected; see
  // `submit` in components/Terminal.tsx.
  useStore.setState({ terminalDeviceId: step.src });

  const landedBefore = useStore.getState().packetsLanded;
  const packetBefore = useStore.getState().packet;
  runTerminal(`ping ${target}`);

  // A ping with no packet behind it (an unparseable target, a scripted output)
  // has nothing to wait for. `animatePath` always makes a fresh object, so
  // identity is the honest test for "did this launch something".
  if (useStore.getState().packet === packetBefore) return;

  const landed = await waitForState(
    (s) => s.packetsLanded > landedBefore,
    PACKET_TIMEOUT_MS,
    ctx.pause,
  );
  if (!landed) {
    ctx.warn(
      `${where}: the packet to ${target} never reported landing within ` +
        `${PACKET_TIMEOUT_MS}ms — the canvas may not be animating`,
    );
  }
}

/**
 * Wait for the store to satisfy `predicate`, or for `timeoutMs` to pass.
 *
 * Subscribed rather than polled, so the runner resumes on the frame the packet
 * actually arrives. The timeout is driven through the same `pause` the rest of
 * the runner uses, which is how a test with `sleep: () => resolve()` gets a
 * promise that settles instead of a twelve-second hang.
 */
function waitForState(
  predicate: (state: ReturnType<typeof useStore.getState>) => boolean,
  timeoutMs: number,
  pause: (ms: number) => Promise<void>,
): Promise<boolean> {
  if (predicate(useStore.getState())) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve(value);
    };
    const unsubscribe = useStore.subscribe((state) => {
      if (predicate(state)) finish(true);
    });
    void pause(timeoutMs).then(() => finish(false));
  });
}

// --- Browser entry point ---------------------------------------------------

/** What `window.__geekednetReplay` carries, for the recorder to watch. */
/**
 * The finished clip's subtitle track, rendered and ready to write.
 *
 * Rendered here rather than handed over as cues because of who reads it: the
 * recorder is a node script that cannot import the engine (it resolves `.js`
 * specifiers that only exist as `.ts`), and its whole stated job is to point a
 * window at the page and save what comes out. Giving it text keeps it that
 * simple — it writes the file, it does not format one.
 */
export interface ReplayCaptionTrack {
  /** SRT, the format video editors and upload flows take. */
  srt: string;
  /** Length of the clip in ms, by the replay's own pacing. */
  durationMs: number;
}

export interface ReplayStatus {
  labId: string;
  replayId: string | null;
  status: 'running' | 'done' | 'error';
  /** Index of the step in flight, or the count of steps done once finished. */
  step: number;
  total: number;
  error?: string;
  warnings: string[];
  /**
   * Present on a `done` status only.
   *
   * Left off while the replay is running because the recorder polls this object
   * four times a second, and a subtitle file does not change between steps.
   */
  captions?: ReplayCaptionTrack;
}

declare global {
  interface Window {
    /**
     * Replay progress, published for `scripts/record.ts` to poll.
     *
     * A programmatic signal rather than something read off the screen: the
     * recorder must know when the run is finished, and asking it to watch for a
     * pixel or a class name would put the layout back in the loop that replay
     * mode exists to keep out of it.
     */
    __geekednetReplay?: ReplayStatus;
  }
}

const REPLAY_STATUS_KEY = '__geekednetReplay';

function publish(status: ReplayStatus): void {
  if (typeof window === 'undefined') return;
  window[REPLAY_STATUS_KEY] = status;
}

/**
 * Read the URL, open the lab it names, and play the replay it names.
 *
 * Resolves rather than rejects on failure: the error goes to the console, to the
 * status object the recorder polls, and to the canvas's own result banner, so it
 * is visible in the recording itself rather than only in a terminal nobody
 * kept.
 */
export async function startReplayFromUrl(
  search: string,
  options: Pick<ReplayRunOptions, 'speed' | 'sleep'> = {},
): Promise<void> {
  const request = readReplayRequest(search);
  if (!request) return;

  let status: ReplayStatus = {
    labId: request.labId ?? '',
    replayId: request.replayId,
    status: 'running',
    step: 0,
    total: 0,
    warnings: [],
  };

  try {
    const { lab, replay } = resolveReplayRequest(request);
    status = { ...status, labId: lab.id, total: replay?.steps.length ?? 0 };

    // Replay mode first: it blanks the in-memory progress, so the lab about to
    // load is one this session has never finished and its win bar can rise.
    if (replay) useStore.getState().enterReplayMode();
    useStore.getState().loadLab(lab.id);

    if (!replay) return; // `?lab=` on its own is just a deep link
    publish(status);

    await runReplay(replay, {
      ...options,
      onStep: (index) => {
        status = { ...status, step: index };
        publish(status);
      },
      onWarning: (message) => {
        console.warn(`[replay] ${message}`);
        status = { ...status, warnings: [...status.warnings, message] };
        publish(status);
      },
    });

    // Subtitles are derived from the replay that just played, so they describe
    // the clip that was actually recorded rather than one authored beside it.
    let captions: ReplayCaptionTrack | undefined;
    try {
      const track = replayCaptions(replay, { captionFallback: DEFAULT_SETTLE_MS });
      captions = { srt: toSrt(track), durationMs: track.durationMs };
    } catch (err) {
      // A clip that cannot be subtitled is still a clip. Warned, not thrown:
      // failing a finished recording over its subtitle track would throw away
      // the thing that took a minute to make.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[replay] ${message}`);
      status = { ...status, warnings: [...status.warnings, message] };
    }

    publish({ ...status, status: 'done', step: status.total, captions });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[replay] failed:', err);
    publish({ ...status, status: 'error', error: message });
    // Reuses the canvas's failure banner rather than inventing a second way to
    // show an error — a broken replay should be obvious in the video.
    useStore.setState({
      lastResult: { success: false, path: [], reason: `replay failed: ${message}` },
    });
  }
}

/**
 * Module-level, not a ref: a replay is one global side effect on the app, and
 * StrictMode runs mount effects twice in development. Twice would be two runs
 * racing over one store.
 */
let started = false;

/** Mounted once by the app shell. Does nothing unless the URL asks for a replay. */
export function useReplay(): void {
  useEffect(() => {
    if (started) return;
    started = true;
    void startReplayFromUrl(window.location.search);
  }, []);
}
