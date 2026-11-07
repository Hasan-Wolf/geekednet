# GeekedNet

A browser-based game that teaches computer networking by letting you build the network, watch the packets move, break it, and fix it.

## What it is

GeekedNet is built on a single simulation engine, with every lesson authored as data rather than as its own mini-app. A lab is a graph of devices and cables, each device holding config state (interfaces, IPs, routes); one simulation step answers the only question that matters — *can a packet get from A to B right now, and if not, why?* A mission runner loads a deliberately broken starting state, watches what you change, and checks the win conditions.

Beginner and advanced labs are the same engine. The difference is how much config surface is unlocked.

Below 900px the screen gets a stacked, read-only layout instead of the builder, in two sections. Under
**Labs** the lab arrives already built and addressed; under **Learn Topology** the seven shapes are listed
down the page, and tapping one loads it. Either way a single button sends a packet across what is on
screen, tapping a device shows its config, and nothing is editable or scored. It is driven by the same
engine, the same lab files and the same topology registry — a lab's solved state is derived from its own
objectives, so no topology is authored twice. The phone opens a compact 3D bench with a 2D map
option. At wider sizes, the desktop workbench supports building and editing networks, and clicking
a computer's screen opens its command prompt and network settings.

## Running it locally

Requires [Node.js](https://nodejs.org) 18 or newer (developed on 24).

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

## Other scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the Vite dev server on port 5173 |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm test` | Run the full test suite once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run typecheck` | Type-check the engine without emitting |
| `npm run typecheck:app` | Type-check the engine plus the React app |
| `npm run typecheck:scripts` | Type-check `scripts/` |
| `npm run record` | Film a replay — see [Recording](#recording) |

## Replay mode

Any lab can play itself. Open the app with `?lab=<labId>&replay=<replayId>` and it loads the lab, then executes the steps in `engine/replays/<replayId>.json`:

```
http://localhost:5173/?lab=tier2-static-route.learn&replay=tier2-static-route.walkthrough
```

A replay is data, like a lab. Its steps name lab ids — a device, an interface, an objective — and never a CSS selector, a pixel or a keystroke, so a replay keeps working through any amount of restyling. Each step dispatches the same store action the UI binds to its own inputs: a `runPacket` step is the terminal's own `ping`, which is `simulatePacket` in both directions, animated by the canvas the student watches. There is no second rendering path, so a recording is evidence of the lab actually being solved.

| Step | Fields | Does |
|---|---|---|
| `configure` | `deviceId`, `field` (`ip` / `mask` / `gateway` / `powered`), `value`, plus `interfaceId` for `ip` and `mask` | Sets one field in the config panel |
| `addRoute` | `deviceId`, `dst`, `mask`, `gateway` | Appends a static route to a router |
| `runPacket` | `src`, and exactly one of `dstIp` / `dstDevice` | Pings from that device's terminal |
| `wait` | `ms` | Holds the frame |
| `highlight` | `objectiveId` | Calls out one objective in the list |

Every step also takes an optional `note` (for whoever reads the JSON) and, except `wait`, a `settleMs` that overrides the default pause after it.

Replays are validated at import, twice: the shape of each step, then every id it names against the lab it drives. An unknown step type, a misspelled field, a renamed device, or a gateway set on a switch is a startup error naming the replay and the step — never a replay that silently does less than it says.

Replay mode banks the lab in memory so the win bar rises for the camera, but writes nothing to saved progress.

## Recording

```bash
npm run record -- --lab tier2-static-route.learn --replay tier2-static-route.walkthrough --size reel
```

Starts the app, opens it at the replay URL, waits for the run to report itself finished, and writes a WebM to `video/assets/`. `--size reel` is 1080x1920 and `--size wide` is 1920x1080; `--mp4` also transmuxes with ffmpeg when one is on PATH, `--url <origin>` films an already-running server, and `--help` lists the rest. Needs Playwright's Chromium once:

```bash
npx playwright install chromium
```

The recorder never clicks or types. Replay mode drives the lab from inside the page, and the only thing read back out is `window.__geekednetReplay`, a status object — so a restyle cannot break a recording, and a recording can never be of something other than what the replay did.

**The three-column stage is a desktop layout.** At `wide` the whole topology frames correctly; at `reel` the canvas column is too narrow for a four-device lab and the right-hand devices are clipped. Making the stage reflow for portrait is an app-layout change, not a recorder one.

## Layout

```
engine/      Pure simulation engine — no UI imports
  ip.ts            addressing and subnet math
  simulate.ts      packet reachability, with failure reasons
  linkState.ts     link and interface state
  deviceConfig.ts  what each kind of device can be configured with
  missionRunner.ts mission lifecycle and win conditions
  schema.ts        shared primitives for the content checks
  validate.ts      lab schema validation
  replay.ts        replay schema validation
  labs/            labs authored as JSON
  replays/         replays authored as JSON
src/         React UI that consumes the engine's public API
  components/      canvas, terminal, config panel, objectives
  terminalEngine.ts  the in-lab CLI
  replay.ts        runs a replay through the store's own actions
  topologies/      topology reference data
  phone/           compact 3D bench and read-only phone layout below 900px
scripts/     Developer tooling
  record.ts        films a replay with Playwright
```

The engine is deliberately independent of the UI: it has no React dependency and is tested on its own. Vite and Vitest both resolve the engine's `.js` import specifiers to their TypeScript sources, so there is no build step between the two halves.

## Tech

React 18 · TypeScript · Vite · Zustand · Vitest · Playwright
