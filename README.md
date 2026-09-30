# GeekedNet

A browser-based game that teaches computer networking by letting you build the network, watch the packets move, break it, and fix it.

## What it is

GeekedNet is built on a single simulation engine, with every lesson authored as data rather than as its own mini-app. A lab is a graph of devices and cables, each device holding config state (interfaces, IPs, routes); one simulation step answers the only question that matters — *can a packet get from A to B right now, and if not, why?* A mission runner loads a deliberately broken starting state, watches what you change, and checks the win conditions.

Beginner and advanced labs are the same engine. The difference is how much config surface is unlocked.

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
| `npm run typecheck` | Type-check without emitting |

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
```

The engine is deliberately independent of the UI: it has no React dependency and is tested on its own. Vite and Vitest both resolve the engine's `.js` import specifiers to their TypeScript sources, so there is no build step between the two halves.

## Tech

React 18 · TypeScript · Vite · Zustand · Vitest
