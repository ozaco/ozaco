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
  hot-reload, `crud`). `crud(table, …)` is typed end to end: `schema` transforms reshape the derived zod
  schemas in the TYPES too, `scope` is the trusted per-caller filter (tenancy, optionally
  `{ read, write }`), `ops` sets per-op options/errors; the manifest is `ozaco/2` (unified
  action+socket entries) and realtime sockets authorize with a first `{ t: 'auth' }` frame
  (tokens never ride the URL). `createServer({ plugins })` takes `Plugin.use(...)` values.
  `server.reload(services)` swaps declarations on a running node (atomic; edge remount, carrier
  re-serve, `hooks.reload`); `HotReload.use({ entry, watch })` drives it from file changes (Bun:
  `Bun.build` bundles the watched subgraph into a fresh temp module per generation — never rely
  on `Loader.registry`, it is absent under `bun test`; Bun's resolver caches directory entries,
  so each generation gets its own directory). See `packages/server/README.md`.
- **`@ozaco/client`** – the manifest-driven typed client for a `@ozaco/server` node
- **`@ozaco/ai`**, **`@ozaco/cli`** – AI providers and the CLI toolkit
- `apps/panel` (docs try-it UI) and `apps/observe` (dev console) are embedded into the server's
  `Docs` / `ObservePlugin`; `examples/demo` is the end-to-end reference app.

**Workspaces** (root `package.json`): `packages/`, `plugins/`, `apps/`, `tools/`, `experiments/`,
`examples/` — only `packages/`, `apps/` and `examples/` exist on disk today.

### @ozaco/std Modules

The core package exports these modules via path aliases (e.g., `std:result`, `std:logger`). Every
plugin installs with `yield* Plugin.use(...args)` (`yield* JsonCodec.use()`,
`yield* WsClient.use({ codec })`) — there is no `install()`. Error tags AND cause names are
`createTags` bundles with dotted values, one per module, exported from the module barrel
(`EffectErrors`/`EffectCauses`, `PluginErrors`, `SharedErrors`, `CodecErrors`, `ConfigErrors`,
`IOErrors`/`IOCauses`, `FetchErrors`, `WsErrors`/`WsCauses`, `RtcErrors`/`RtcCauses`; server adds
`AuthErrors`/`AuthCauses`, `ResilienceCauses` and `serviceErrors(...)` on top; `WsErrors.Connect`
is `'std:ws.connect'`). Never pass a bare string as a tag or a cause — `fail(XErrors.Tag, message,
...XCauses)` and `operation(fn, XCauses.Step)`; tests assert the dotted literal or the bundle
member. To substitute a platform implementation, implement the protocol (`Ws.implement(...)`,
`Rtc.implement(...)`) — never an `impl` option (see `tests/ws/helpers.ts` `wsMock`,
`tests/webrtc/fake.ts` `rtcMock`). Plugin/protocol names all start with `std/`
(`std/io`, `std/bun-io`, `std/logger`, `std/default-logger`, `std/console-transport`,
`std/file-transport`, `std/ws`, `std/ws-client`, `std/webrtc`, `std/webrtc-client`, …). Retry
budgets and re-armed gates are `std:effect` primitives (`budgetOf`/`budgetDelay`/`BUDGET_DEFAULTS`,
`createGate`), frame-decoding subscriptions come from `Codec.actions.decodeFrames` — ws and webrtc
share them instead of re-implementing them.
See `packages/std/README.md` for how each module works underneath.

- **result** - `Result<T,E>` / `Maybe` types with `fail`, `succeed`, `appendCauses`, `asFailure`, `asFailureFrom`, `auto`, `throwable`, `unwrap`, `just`, `nothing` and the `is*` guards (`isSuccess`/`isFailure`/`isResult`/`isJust`/`isNothing`/`isMaybe`); no `map`/`orElse`/`pipe` here
- **shared** - Common types (`AnyType`, `EmptyType`, `Simplify`, `Tags`, exported `Helpers`) and utilities: `createTags`, `match`, `pipe`, `deepMerge`, path helpers (`getPath`/`setPath`/`unsetPath`/`flatten`/`flattenEntries`), `validateSync`, `serializeError`, `hasFlag`, `lazyPromise`, `PriorityQueue`, runtime guards (`isPromise`, `isArray`, …; `isResult` lives in `result`)
- **effect** - Effection-style structured concurrency: `Operation`, `Flow` (the effect stream abstraction — "stream" refers only to native platform streams), scopes, contexts, signals/channels/queues; `spawn` returns at once (the child may never start if the scope closes first), `fork` is guaranteed started before it returns and is supervised — use `fork`/`resource` when teardown must be armed; `attempt`/`recover`/`mapError` handle failures as values (`box` is gone); `EffectErrors` = halted, iteration-error, missing-context, no-scope-handler, using
- **event** - Typed event emitter (`createEvent`) plus effect bridges (`useEvent`, `onEvent`, `useEventOnce`, `useBufferedEvent`)
- **plugin** - Plugin architecture: protocols (`defineProtocol` with `handlers`/`defaults`/`exec`, `Protocol.implement(...).build(...)`), `definePlugin`, `Plugin.use`, contexts, `before`/`after`/`around`/`error` hooks; `PluginErrors` = missing-action, protocol-not-cloneable
- **codec** - Codec protocol with `JsonCodec`/`TomlCodec`/`YamlCodec` impls (`encode`/`decode`, `stringify`/`parse`, `encodeFlow`/`decodeFlow`) plus the `encodeFrame`/`decodeFrame` protocol handlers used by ws/webrtc; `CodecErrors` incl. `AlreadyRegistered`; `YamlCodec` exists but nothing in the monorepo uses it
- **config** - Config discovery/merge/edit/watch plugin: `Config.use(options)` builds the context only, `Config.actions.load()` discovers; needs an IO impl + the file codec (default `TomlCodec`) installed; `JsonCodec` is required only by `watch` (change-detection fingerprint); `Features` bitflags from bit 0 (FILE=1, CHAIN=2, VARIANT=4, ENV=8, DIR=16); `ConfigErrors.MissingExtends`
- **io** - Platform IO protocol (`BunIO`/`NodeIO`/`WebIO`; every type lives in the `IODef` namespace of `types/io.ts` — `IODef.Actions` is the contract, `IODef.S3Options`, `IODef.WatchEvent`, … the shapes): fs (`IO_FLAGS` from bit 0: FOLLOW_SYMLINKS=1, FILES=2, DIRS=4, APPEND=8, EXCLUSIVE=16), flows, path helpers, processes, net, env/ip/tmpdir, crypto, `ulid`/`uuid`/`hlc`, watch (Watchman preferred, `STD_WATCHMAN=off` disables it, `fs.watch` fallback), S3 (Bun native / Node SigV4-over-fetch / Web unsupported; reads stream via `file.stream()`, a `ReadableStream` body streams up as a multipart upload with `partSize` parts — Bun's `writer()` sink, the fetch client's own multipart path); `internal/` is grouped by domain: `crypto/` (node, web, ulid, uuid, hlc), `fs/` (flow, walk, watch), `stream/` (from-readable, to-readable), `path/` (node, web), `process/` (shared, bun, node), `net/` (sockets, sys), `s3/` (config, sign, transport, xml, multipart, fetch, create); `IOErrors` = unsupported, exists, missing-env, exec-failed, exec-spawn-failed, spawn-failed, process-error, kill-failed, stdin-write-failed, sign-failed, verify-failed, hlc-invalid, decrypt-failed, s3-failed, tcp-listen-failed, tcp-connect-failed, tcp-write-failed, udp-bind-failed, udp-send-failed; `IOCauses` = stream, write-stream
- **logger** - `Logger` (impl `DefaultLogger`, also at `std:logger/impl/default`) + cloneable `LoggerTransport` fan-out (`std:logger/transport/console`, `std:logger/transport/file`); both transports' default formats pin `JsonCodec`; `ConsoleTransport` reads the logger context in `setup`, so install it after `DefaultLogger`
- **fetch** - HTTP client protocol `Fetch` + impl `FetchClient.use({ baseUrl, headers, timeoutMs, codec })`; two-step response API (no builders): `const res = yield* Fetch.actions.get(url)` then `yield* res.json()` / `res.expect()`; verb shorthands call the pinned `FetchClient.actions.request` (hooks still wrap, so `Fetch.around({ request })` sees every call); platform call injectable via the `fetchImpl` context; `FetchErrors` = timeout, http-status, parse
- **ws** - WebSocket protocol `Ws` (routed `Ws.actions.connect`, hooks via `Ws.around({ connect })`) + impl `WsClient.use({ codec, reconnect, keepalive, … })`; `connect` returns a scope-bound resource with optional auto-`reconnect` (one continuous `messages` Flow across generations) and `keepalive`; `WsClient` constructs sockets with `globalThis.WebSocket`, read at connect time (no `WebSocket` global → `WsErrors.Unsupported`); a mock implements the protocol (`Ws.implement(...).build({ connect })`, see `tests/ws/helpers.ts` `wsMock`); `WsErrors` = connect, unsupported, reconnect-exhausted; `WsCauses` = connect, dial, send, close, keepalive, reconnect
- **webrtc** - WebRTC protocol `Rtc` (routed `Rtc.actions.connect`, hooks via `Rtc.around({ connect })`) + impl `RtcClient.use(defaults?)` (client AND server — the API is peer-symmetric): `Rtc.actions.connect(signal, options)` negotiates over any `{ send, messages }` duplex (a `Ws` connection qualifies) and returns a scope-bound peer; data channels are Flow-based with backpressure-aware `send`, ICE restarts (`iceRestart`) and whole-session redials (`reconnect`, ws-style — local channels/tracks survive) are supervised; typed media via `peer.addTrack` → `Sender` + remote `tracks` Flow (browser-first — impl without `addTrack` fails `RtcErrors.Unsupported`); `RtcClient` resolves `RTCPeerConnection` at connect time (the browser global, else the auto-imported `node-datachannel` polyfill on Bun/Node, else `RtcErrors.Unsupported`); a mock implements the protocol (`Rtc.implement(...).build({ connect })`, see `tests/webrtc/fake.ts` `rtcMock`); observability is always on — `peer.metrics` (session counters), a bounded `peer.timeline` plus the live `peer.events` Flow (kinds: dial/state/offer/answer/glare/candidate/channel/track/ice-restart/redial/stats/close/error), and `peer.stats()` normalizing the impl's `getStats` (`observe: { sampleMs, timeline }` sizes it and turns the sampler on); `RtcErrors` = unsupported, connect, connection, negotiation, signal, ice-exhausted, reconnect-exhausted, channel, timeout, track, stats; `RtcCauses` names every pump/supervisor/handle operation

### Key Patterns

- **Error handling:** Use Result helpers (`fail`, `succeed`, `appendCauses`, `asFailure`) with the module's `*Errors` tag bundle, avoid bare throws
- **Exports:** `const` arrows; generator actions/helpers must be `function*` declarations (or `operation(function* …)`); keep modules side-effect free, re-export through `index.ts` barrels (`types/helpers.ts` always via `export type *`)
- **Layout:** module root holds `definition.ts` (`definitions.ts` only when several protocols live there, e.g. logger), `errors.ts`, `index.ts`, `types(.ts|/)`, `internal/`, `utils/`; `const.ts` at the root only when the barrel exports it, otherwise `internal/const.ts`; sub-path implementations live under `impl/` (`std:codec/impl/json`, `std:logger/impl/default`, `std:io/impl/bun`) or `transport/` (logger); `effect/base/` is the one sanctioned extra root directory — the primitives its `utils/` build on
- **Async:** Use `isPromise`/`isResult` helpers, return promises instead of mixing await with mutation
- **Immutability:** Default immutable, mutate only when APIs require it (e.g., pushing into `failure.causes`)
- **New utilities:** public helpers go in `packages/std/src/<module>/utils/` and are exported from the barrel immediately; module-private helpers go in `<module>/internal/` and are never imported from outside the module

## Code Style

OXC is canonical (oxlint + oxfmt): 2 spaces, width 100, single quotes, JSX single quotes, trailing commas `all`, no semicolons.

- **Import order:** external packages → `std:*` aliases → relatives
- **Use `import type`** for type-only imports
- **Naming:** camelCase values, PascalCase types, SCREAMING_SNAKE_CASE for shared constants; type namespaces are `<Module>Def` (consumer-facing), `Utils` (public utils' types), `Helpers` (internal shapes, still exported)
- **TypeScript:** Honor `tsconfig.base.json` strictness (no relaxing `strict`, `verbatimModuleSyntax`)
