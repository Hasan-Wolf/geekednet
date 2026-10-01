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
objectives — so no topology is authored twice. Above that width the desktop stage is untouched.

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
| `npm run typecheck` | Type-check the engine (no emit) |
| `npm run typecheck:app` | Type-check the engine *and* the React UI under `src/` |

## Layout

```
engine/      Pure simulation engine — no UI imports
  ip.ts            addressing and subnet math
  simulate.ts      packet reachability, with failure reasons
  linkState.ts     link and interface state
  missionRunner.ts mission lifecycle and win conditions
  validate.ts      config validation
  labs/            labs authored as JSON
src/         React UI that consumes the engine's public API
  components/      canvas, terminal, config panel, objectives
  terminalEngine.ts  the in-lab CLI
  topologies/      topology reference data
  phone/           the stacked read-only layout below 900px
```

The engine is deliberately independent of the UI: it has no React dependency and is tested on its own. Vite and Vitest both resolve the engine's `.js` import specifiers to their TypeScript sources, so there is no build step between the two halves.

## Tech

React 18 · TypeScript · Vite · Zustand · Vitest
