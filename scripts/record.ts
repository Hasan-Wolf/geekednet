/**
 * Record a replay to a video file.
 *
 *   npm run record -- --lab <labId> --replay <replayId> --size reel|wide
 *
 * Starts the app, opens it at `?lab=…&replay=…`, waits for replay mode to report
 * that it has finished, and writes the clip to `video/assets/`.
 *
 * The recorder deliberately knows nothing about the app's markup. It does not
 * click, type, or wait for an element: replay mode drives the lab from inside
 * the page through the store's own actions, and this script's entire job is to
 * point a window at it, hold the frame, and save the file. The one thing it reads
 * out of the page is `window.__geekednetReplay` — a status object, not a pixel —
 * so a restyle can never break a recording and a recording can never be of
 * something other than what the replay did. See src/replay.ts.
 *
 * Playwright records WebM. `--mp4` additionally transmuxes with ffmpeg when one
 * is on PATH; the WebM is always written, so a machine without ffmpeg still gets
 * a usable clip.
 */

import { spawn } from 'node:child_process';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'video', 'assets');

/**
 * The two shapes the curriculum is cut for: a vertical reel, and a conventional
 * landscape frame. Named rather than free-form so every clip in the library is
 * one of two sizes and nothing has to be re-cropped later.
 */
const SIZES = {
  reel: { width: 1080, height: 1920 },
  wide: { width: 1920, height: 1080 },
} as const;

type SizeName = keyof typeof SIZES;

/** Longest a replay may take before the recorder gives up on it. */
const REPLAY_TIMEOUT_MS = 180_000;

/** Frames held after the replay reports done, so the win bar is on screen at the end. */
const DEFAULT_TAIL_MS = 1800;

interface Options {
  labId: string;
  replayId: string;
  size: SizeName;
  /** An already-running server to film instead of starting one. */
  url: string | null;
  outDir: string;
  tailMs: number;
  mp4: boolean;
  headed: boolean;
  /** Write the `.srt` subtitle track beside the clip. */
  captions: boolean;
}

const USAGE = `
Usage: npm run record -- --lab <labId> --replay <replayId> [options]

  --lab      <id>          lab to open, e.g. tier2-static-route.learn
  --replay   <id>          replay to play, e.g. tier2-static-route.walkthrough
                           or "auto" to derive one from the lab's objectives,
                           which needs no replay JSON at all
  --size     reel|wide     frame size (default: reel — ${SIZES.reel.width}x${SIZES.reel.height};
                           wide is ${SIZES.wide.width}x${SIZES.wide.height})
  --url      <origin>      film this running server instead of starting one
  --out      <dir>         output directory (default: video/assets)
  --tail     <ms>          hold after the replay finishes (default: ${DEFAULT_TAIL_MS})
  --mp4                    also transmux to .mp4 (needs ffmpeg on PATH)
  --no-captions            skip the .srt subtitle track written beside the clip
  --headed                 show the browser window while recording
  --help                   this text
`.trim();

function parseArgs(argv: string[]): Options {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument "${arg}"`);
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.set(key, true);
    } else {
      flags.set(key, next);
      i += 1;
    }
  }

  if (flags.has('help')) {
    console.log(USAGE);
    process.exit(0);
  }

  const text = (key: string): string | null => {
    const value = flags.get(key);
    if (value === undefined) return null;
    if (value === true) throw new Error(`--${key} needs a value`);
    return value;
  };

  const labId = text('lab');
  const replayId = text('replay');
  if (!labId || !replayId) {
    throw new Error(`--lab and --replay are both required\n\n${USAGE}`);
  }

  const size = (text('size') ?? 'reel') as SizeName;
  if (!(size in SIZES)) {
    throw new Error(`--size must be one of ${Object.keys(SIZES).join(', ')} — got "${size}"`);
  }

  const tail = text('tail');
  const tailMs = tail === null ? DEFAULT_TAIL_MS : Number(tail);
  if (!Number.isFinite(tailMs) || tailMs < 0) {
    throw new Error(`--tail must be a duration in milliseconds — got "${tail}"`);
  }

  const known = [
    'lab', 'replay', 'size', 'url', 'out', 'tail', 'mp4', 'headed', 'no-captions', 'help',
  ];
  for (const key of flags.keys()) {
    if (!known.includes(key)) throw new Error(`unknown flag --${key}\n\n${USAGE}`);
  }

  return {
    labId,
    replayId,
    size,
    url: text('url'),
    outDir: text('out') ?? OUT_DIR,
    tailMs,
    mp4: flags.get('mp4') === true,
    headed: flags.get('headed') === true,
    // On by default: the track costs nothing to produce and the clip is watched
    // on mute. Opting out is for the rare clip that is captioned elsewhere.
    captions: flags.get('no-captions') !== true,
  };
}

/**
 * Start the app on an ephemeral port, in-process.
 *
 * Programmatic Vite rather than a spawned `npm run dev`: the recorder gets the
 * resolved URL back directly, and the server dies with this process instead of
 * being orphaned when a recording fails.
 */
async function startApp(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: ViteDevServer = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.ts'),
    // Not strict about the port: a dev server already running on the configured
    // one is stepped past rather than fought over, and the resolved URL below is
    // what gets filmed either way.
    server: { strictPort: false, open: false },
    logLevel: 'warn',
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) {
    await server.close();
    throw new Error('vite started but reported no local URL');
  }
  return { url: url.replace(/\/$/, ''), close: () => server.close() };
}

/** What `window.__geekednetReplay` looks like from out here. */
interface ReplayStatus {
  status: 'running' | 'done' | 'error';
  step: number;
  total: number;
  error?: string;
  warnings: string[];
  /**
   * Subtitles for the clip, on a finished run — already rendered as SRT, since
   * this script cannot import the engine that knows how to format them.
   */
  captions?: { srt: string; durationMs: number };
}

async function record(options: Options): Promise<void> {
  await mkdir(options.outDir, { recursive: true });

  const app = options.url ? null : await startApp();
  const origin = options.url ?? app!.url;
  const { width, height } = SIZES[options.size];
  const target = `${origin}/?lab=${encodeURIComponent(options.labId)}&replay=${encodeURIComponent(
    options.replayId,
  )}`;

  console.log(`▶ recording ${options.replayId} (${options.size} ${width}x${height})`);
  console.log(`  ${target}`);

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: !options.headed });
    const context = await browser.newContext({
      viewport: { width, height },
      // Matched to the viewport: the clip is the app at its real size, not a
      // scaled screenshot of it.
      recordVideo: { dir: options.outDir, size: { width, height } },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(String(error)));

    await page.goto(target, { waitUntil: 'load' });

    // The only thing read out of the page, and it is state rather than markup.
    const status = await page
      .waitForFunction(
        () => {
          // Evaluated in the page. Reached through globalThis, and typed here
          // rather than imported, so this script needs no DOM lib of its own —
          // the contract it depends on is the one src/replay.ts publishes.
          const { __geekednetReplay: replay } = globalThis as unknown as {
            __geekednetReplay?: ReplayStatus;
          };
          return replay && replay.status !== 'running' ? replay : null;
        },
        undefined,
        { timeout: REPLAY_TIMEOUT_MS, polling: 250 },
      )
      .then((handle) => handle.jsonValue() as Promise<ReplayStatus>);

    if (status.status === 'error') {
      throw new Error(`replay failed in the page: ${status.error ?? 'no reason given'}`);
    }
    for (const warning of status.warnings) console.warn(`  ! ${warning}`);
    console.log(`  replay finished ${status.step}/${status.total} steps`);

    // Hold the final frame before cutting, then close the context — which is
    // what finalises the video file; `video.path()` is not readable until then.
    await page.waitForTimeout(options.tailMs);
    const video = page.video();
    if (!video) throw new Error('playwright recorded no video for this page');
    const temp = await video.path();
    await context.close();

    const webm = path.join(
      options.outDir,
      `${options.labId}--${options.replayId}--${options.size}.webm`,
    );
    await rm(webm, { force: true });
    await rename(temp, webm);
    console.log(`✔ ${path.relative(ROOT, webm)} (${await sizeOf(webm)})`);

    // The subtitle track beside the clip, named to match so a player and most
    // upload flows pair them without being told. A clip with no captions is a
    // clip of boxes changing colour to anyone watching on mute.
    if (options.captions && status.captions) {
      const srt = webm.replace(/\.webm$/, '.srt');
      await writeFile(srt, status.captions.srt, 'utf8');
      const cues = status.captions.srt.split('\n\n').filter(Boolean).length;
      console.log(`✔ ${path.relative(ROOT, srt)} (${cues} cues)`);
    }

    if (options.mp4) await toMp4(webm);
    if (consoleErrors.length > 0) {
      // Not fatal: the clip is already written and may be perfectly usable. But
      // a page error during a recording is worth seeing before it is published.
      console.warn(`  ! ${consoleErrors.length} console error(s) during the run:`);
      for (const error of consoleErrors.slice(0, 5)) console.warn(`    ${error}`);
    }
  } finally {
    await browser?.close();
    await app?.close();
  }
}

async function sizeOf(file: string): Promise<string> {
  const { size } = await stat(file);
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Transmux to MP4 if ffmpeg is available.
 *
 * A warning rather than a failure when it isn't: the WebM beside it is the
 * recording, and a missing optional tool should not throw away a clip that took
 * a minute to make.
 */
async function toMp4(webm: string): Promise<void> {
  const mp4 = webm.replace(/\.webm$/, '.mp4');
  const args = ['-y', '-i', webm, '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', mp4];

  const code = await new Promise<number | null>((resolve) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    child.on('error', () => resolve(null));
    child.on('close', resolve);
  });

  if (code === null) {
    console.warn('  ! --mp4 asked for but ffmpeg is not on PATH — the .webm is still written');
    return;
  }
  if (code !== 0) {
    console.warn(`  ! ffmpeg exited ${code} — the .webm is still written`);
    return;
  }
  console.log(`✔ ${path.relative(ROOT, mp4)} (${await sizeOf(mp4)})`);
}

try {
  await record(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
