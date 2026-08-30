# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**All workflows must go through Moon** - never invoke Bun/OXC directly except for debugging.

```bash
bun install                           # Install dependencies (Bun 1.3.9 pinned via Moon)
moon run :check                       # Full lint + format check (oxlint + oxfmt)
moon run :test                        # Every package's fast test suite (parallel; cap with -c/--concurrency N)
moon run :test-all                    # EVERYTHING incl. docker legs (pg, redis, nats, network, chaos, bus)
moon run :apply                       # Auto-fix formatting and lint
moon run :apply-unsafe                # Auto-fix with dangerous rewrites (oxlint --fix-dangerous)
moon run :clean                       # Reset build artifacts (dist, .ozaco)
moon run std:build                    # Build @ozaco/std package (tsdown)
```

Pre-commit hook runs `moon run :check --affected`.

## Architecture

This is a TypeScript monorepo of layered runtime packages, all built on the same plugin/effect
foundation. Layers, bottom up:

- **`@ozaco/std`** – the standard library (effect, plugin, io, codec, logger, fetch, ws, webrtc…)
- **`@ozaco/transport`** – the messaging plane (`memory` / `nats` / `redis` / `worker` impls)
- **`@ozaco/db`** – the reactive, adapter-agnostic database + `Kv` (`memory` / `sqlite` / `pg` /
  `bun-sql`, `memory-kv` / `redis-kv`)
- **`@ozaco/server`** – the service/action kernel: `service()` / `action.*` / `createServer`, with
  edges (bun/node/deno), carriers, and plugins (auth, cache, cors, docs, observe, resilience,
  `crud`). `crud(table, …)` is typed end to end: `schema` transforms reshape the derived zod
  schemas in the TYPES too, `scope` is the trusted per-caller filter (tenancy, optionally
  `{ read, write }`), `ops` sets per-op options/errors; the manifest is `ozaco/2` (unified
  action+socket entries) and realtime sockets authorize with a first `{ t: 'auth' }` frame
  (tokens never ride the URL). See `packages/server/README.md`.
- **`@ozaco/client`** – the manifest-driven typed client for a `@ozaco/server` node
- **`@ozaco/ai`**, **`@ozaco/cli`** – AI providers and the CLI toolkit
- `apps/panel` (docs try-it UI) and `apps/observe` (dev console) are embedded into the server's
  `Docs` / `ObservePlugin`; `examples/demo` is the end-to-end reference app.

**Workspaces:** `packages/`, `plugins/`, `apps/`, `tools/`

### @ozaco/std Modules

The core package exports these modules via path aliases (e.g., `std:result`, `std:logger`):

- **result** - `Result<T,E>` type with utilities: `fail`, `succeed`, `appendCauses`, `orElse`, `pipe`, `guard`, `map`
- **shared** - Common types (`BlobType`, `Helpers`) and utilities (`isPromise`, `isResult`, `deepMerge`, `match`)
- **effect** - Effection-style structured concurrency: `Operation`, `Flow` (the effect stream abstraction — "stream" refers only to native platform streams), `spawn`/`fork` (fork for background pumps whose result is not awaited), scopes, signals/channels/queues
- **event** - Typed event emitter (`createEvent`) plus effect bridges (`useEvent`, `onEvent`, `useBufferedEvent`)
- **plugin** - Plugin architecture: protocols, `install`, contexts, `around`/`before`/`after` hooks
- **codec** - Codec protocol with `JsonCodec`/`TomlCodec`/`YamlCodec` impls (`encode`/`decode`, `encodeFlow`/`decodeFlow`)
- **config** - Config discovery/merge/watch plugin (installed with an IO impl + the config file codec; `JsonCodec` must also be installed — config pins it as a baseline, e.g. for watch change-detection)
- **io** - Platform IO protocol (`BunIO`/`NodeIO`/`WebIO`): fs, flows, processes, net, crypto, watch
- **logger** - Logger plugin with transport abstraction (`std:logger/transport/console`, `std:logger/transport/file`)
- **fetch** - HTTP client plugin: `install(Fetch, { baseUrl, headers, timeoutMs })`, `Fetch.actions.get(...).json()` builders, `Fetch.around` middleware over the single `request` dispatch
- **ws** - WebSocket client plugin: `Ws.actions.connect` returns a scope-bound resource with optional auto-`reconnect` (one continuous `messages` Flow across generations) and `keepalive`
- **webrtc** - WebRTC peer plugin (client AND server — the API is peer-symmetric): `Rtc.actions.connect(signal, options)` negotiates over any `{ send, messages }` duplex (a `Ws` connection qualifies) and returns a scope-bound peer; data channels are Flow-based with backpressure-aware `send`, ICE restarts (`iceRestart`) and whole-session redials (`reconnect`, ws-style — local channels/tracks survive) are supervised; typed media via `peer.addTrack` → `Sender` + remote `tracks` Flow (browser-first — impl without `addTrack` fails `rtc/unsupported`); browser global or auto-imported `node-datachannel` polyfill (optional dep) on Bun/Node, injectable via `rtcImpl`; observability is always on — `peer.metrics` (session counters), a bounded `peer.timeline` plus the live `peer.events` Flow (dial/offer/answer/glare/candidate/channel/track/ice-restart/redial/close), and `peer.stats()` normalizing the impl's `getStats` (`observe: { sampleMs, timeline }` sizes it and turns the sampler on)

### Key Patterns

- **Error handling:** Use Result helpers (`fail`, `succeed`, `appendCauses`, `orElse`), avoid bare throws
- **Exports:** Use `const` arrows, keep modules side-effect free, re-export through `index.ts` barrels
- **Async:** Use `isPromise`/`isResult` helpers, return promises instead of mixing await with mutation
- **Immutability:** Default immutable, mutate only when APIs require it (e.g., pushing into `failure.causes`)
- **New utilities:** Add to `packages/std/src/<domain>/utils`, export immediately

## Code Style

OXC is canonical (oxlint + oxfmt): 2 spaces, width 100, single quotes, JSX single quotes, trailing commas `all`, no semicolons.

- **Import order:** external packages → `std:*` aliases → relatives
- **Use `import type`** for type-only imports
- **Naming:** camelCase values, PascalCase types, SCREAMING_SNAKE_CASE for shared constants
- **TypeScript:** Honor `tsconfig.base.json` strictness (no relaxing `strict`, `verbatimModuleSyntax`)
