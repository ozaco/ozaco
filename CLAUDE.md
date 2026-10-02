# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**All workflows must go through Moon** - never invoke Bun/OXC directly except for debugging.

```bash
bun install                           # Install dependencies (Bun 1.3.9 pinned via Moon)
moon run :check                       # Full lint + format check (oxlint + oxfmt)
moon run :test                        # Every package's fast test suite (parallel; cap with -c/--concurrency N)
moon run :test-all                    # EVERYTHING incl. docker legs (pg, redis, nats, network, chaos, bus, observe)
moon run :apply                       # Auto-fix formatting and lint
moon run :apply-unsafe                # Auto-fix with dangerous rewrites (oxlint --fix-dangerous)
moon run :clean                       # Reset build artifacts (dist, .ozaco)
moon run std:build                    # Build @ozaco/std package (tsdown)
```

Pre-commit hook runs `moon run :check --affected`.

## Architecture

This is a TypeScript monorepo of layered runtime packages, all built on the same plugin/effect
foundation. Layers, bottom up:

- **`@ozaco/std`** – the standard library (effect, plugin, trace, io, codec, logger, fetch, ws,
  webrtc…)
- **`@ozaco/transport`** – the messaging plane (`memory` / `nats` / `redis` / `worker` impls).
  `request()` injects `traceparent`/`tracestate` (`Trace.actions.inject()`); a failed reply is the
  envelope `{ error, message, causes, origin }` encoded by the routed codec — JsonCodec carries
  the nested failures in `causes` (tag, message, causes — a fold's `raw` stays home), no wire
  helpers — and
  `origin` (`TransportDef.Origin` `{ service, operation, spanId, traceId, flags, recorded }`; the core
  stamps operation / trace / recorded, `serve(…, { origin: (f, req) => Origin })` adds the rest).
  The decoder appends the string cause `remote: <operation> @ <service> span <id8>` and, when the
  sender recorded it, `Trace.actions.markRecorded(f, traceId, { remote: true, spanId, flags })` (no second exception, `Trace.actions.recordedBy(f)` names that span, the
  caller's spans get `ozaco.failure.remote`). Status changes
  (lost / reconnected / closed, reply failures) are Logger lines under `logger: '@ozaco/transport'`
  (`logTransport`, `watchStatus`) — silent without a Logger
- **`@ozaco/db`** – the reactive, adapter-agnostic database + `Kv` (`memory` / `sqlite` / `pg` /
  `bun-sql`, `memory-kv` / `redis-kv` / `table-kv` — the last keeps the Kv as rows of the installed
  adapter, no change log). Column kinds include `blob` (`Uint8Array`; sqlite BLOB / pg BYTEA);
  `where.startsWith` escapes its prefix and LIKE always pins `ESCAPE '\'`; `Db.actions.raw` takes
  one statement or a script (`string[]`, one transaction). `column.timestamp({ as: 'ms' })` is an
  epoch-ms number (plain `timestamp()` stays a `Date`); `query.skip(n)` + offset
  `paginate({ page, pageSize })` (page clamped into `1..pages`, `pages ≥ 1`) beside keyset `paginate({ limit, cursor })`; every `where.*` leaf
  takes a json path (`where.eq(['payload', 'workspace'], v)`); `upsert(…, { when })` →
  `{ op: 'inserted' | 'updated' | 'skipped', doc }` and `insertOrIgnore` (both retry once on
  `db.unique`, so `match` needs a unique index); `db.import(table, rows)` keeps system fields
  (`stripSystem(row)` drops them); memory-adapter top-level transactions are serialized. Sub-paths:
  `@ozaco/db/queue` (`Queue.use({ table: 'jobs' })` over a `queueTable('jobs')` schema table,
  `enqueue`/`work` with dedupe, backoff, leases + sweeper, dead-letter), `@ozaco/db/adapter-kit`
  (`aggregateDocs`, `matches`, `noteQuery`, …) and `@ozaco/db/testing` (`runAdapterSuite`, the only
  entry that imports `bun:test`). Telemetry lives in ONE place (`core/internal/trace.ts`
  `traced(adapter)`): CHILD-ONLY spans (`requireParent` — nothing without a recording parent)
  `{op} {table}` / `transaction` / `raw`, CLIENT (INTERNAL on memory), scope `@ozaco/db`,
  `db.system.name`, `db.namespace` (ALWAYS — Tempo's service graph needs it), `db.collection.name`,
  `db.operation.name`, `db.query.text` (parameterized SQL only), `db.response.status_code`
  (SQLSTATE / `SQLITE_*`), `server.address`/`server.port`;
  `DbClient.use({ observe: { returnedRows } })`; `__changes_*` tables and a Kv's backing table get
  no spans; conflict retries are the span event `db.tx.retry`; Kv ops are `{op} kv` spans
  (`Kv.wrap(…, { onSource })` tells hit/miss/coalesced; a halted leader releases its joiners).
  Watch/hub/bus/queue loops run with no active span. `withBusMeta(data)` rides on every change the writes make (`Change.Event.meta`; the
  server puts the dispatch's `traceparent` there). Queue: `queueTable` carries `traceparent`,
  `tracestate`, `last_traceparent`; `enqueue` = PRODUCER `send {table}`, each attempt a ROOT
  CONSUMER `process {table}` LINKING the enqueue (`creation`) and the previous attempt
  (`queue.retry`), `messaging.message.id` = the job id; a retried failure is WARN, a dead letter
  ERROR + `queue.dead`; `last_error` = the whole chain; an attempt is a root outside any
  dispatch, so it runs as `Queue.use({ table, service })` (default: the table name; a worker's
  `work(…, { service })` wins) — the `service.name` of it and everything under it. Operational
  Logger lines use `logger: '@ozaco/db'` (`dbLog`)
- **`@ozaco/server`** – the service/action kernel: `service()` / `action.*` / `createServer`, with
  edges (bun/node/deno), carriers, and plugins (auth, cache, cors, docs, observe, resilience,
  hot-reload, `crud`). Multi-impl seams are cloneable protocols, never options: `Auth` is the
  gate over `AuthStrategy` impls (`JwtAuth`, `StaticAuth`, installed BEFORE `Auth`; the first
  SUCCESSFUL strategy answers; `Auth.actions.check(req, headers)` answers principal-or-`null`) and
  `ObserveExporter` impls (`StdoutExporter`, `OtlpExporter`, `OpenObserveExporter`) run side by
  side — the kernel fans events out, starts and flushes them. Raw edge routes are gated by the
  same Auth — `Edge.actions.raw({ auth })` and
  `Edge.actions.static({ path, dir, index, dotfiles, followSymlinks, auth })` use the route's
  `auth`,
  else `Auth`'s `default`; `auth: false` is public (`/_health`, the `/_observe` shell — its API is
  gated by `ObservePlugin.use({ auth })`, else `Auth`'s `default` — Docs unless
  `Docs.use({ auth })`) — and the handler's third argument is `{ principal }`. An output-schema
  mismatch fails `server.output` (500), never `server.validation` (400). Never re-wrap with
  `new Response(x.body, x)` — reading `.body` first loses a `Bun.file`'s content-type; use
  `rewrapResponse` from `server:internal`. An action's `errors` map may point a tag at any
  status, `200` included (the `{ error }` envelope + `oz-error` header still mark it a failure;
  the client reads the header);
  `status`/`headers` on the config and `ctx.reply(...)` shape the successful edge reply — on a
  gateway too (the owner's `ctx.reply` rides the carrier reply as `WireDef.Reply.http`).
  `crud(table, …)` is typed end to end: `schema` transforms reshape the derived zod schemas in
  the TYPES too, `scope` is the trusted per-caller filter (tenancy, optionally
  `{ read, write }`), `ops` sets per-op options/errors; the manifest is `ozaco/2` (unified
  action+socket entries) and realtime sockets authorize with a first `{ t: 'auth' }` frame
  (tokens never ride the URL). `createServer({ plugins })` takes `Plugin.use(...)` values.
  `server.reload(services)` swaps declarations on a running node (atomic; edge remount, carrier
  re-serve, `hooks.reload`); `HotReload.use({ entry, watch })` drives it from file changes (Bun:
  `Bun.build` bundles the watched subgraph into a fresh temp module per generation — never rely
  on `Loader.registry`, it is absent under `bun test`; Bun's resolver caches directory entries,
  so each generation gets its own directory). **Observe:** the kernel runs on std:trace and hands
  the sinks exactly two record kinds — `ObserveDef.Event` is `{ t: 'span', span, resource }` or
  `{ t: 'log', log, resource }` — and EVERY sink (the `ObservePlugin` store, `hooks.observe`, each
  `ObserveExporter`) receives the identical record: the log budget (≤ 96 attributes / 48 KiB) is
  applied ONCE before the fan-out; never add a per-sink content option. A node observes when it
  has an exporter or observe hook of its own, or tracing was on around it. Exporter options are
  TRANSPORT ONLY —
  `OtlpExporter.use({ url, headers, signalHeaders, encoding, gzip, timeoutMs, retry, batch, metrics })`
  (`encoding` defaults to `'protobuf'`; `timeoutMs` is ONE budget per batch delivery, retries
  included) and `OpenObserveExporter.use({ url, org, auth, stream, … })`
  (`auth` is `{ user, pass }` or `{ token }`; the same OTLP pipeline — `createOtlpPipeline`,
  `encodeSpans`, `encodeLogs` from `server:plugins/observe/otlp`; OpenObserve refuses fractional
  doubles in OTLP/JSON); `StdoutExporter` prints every span and record (dev). `createServer`
  options: `trace.inbound` — `'link'` (default: a new root LINKING the inbound context, reason
  `remote.parent`), `'continue'` or `'ignore'`; `trace.trust(request)` (continued, sampled flag
  honoured, cause chain in the error reply); `trace.response` (default on: `traceresponse` — the edge span, else, on a non-observing gateway, the owner's answering span carried back as the carrier reply's `traceparent` / the failure origin's recorder — +
  `x-request-id`); `observe.serviceName` — `'service'` (default: a dispatch span names its ozaco
  service), `'node'` or a fixed name; `observe.namespace` (default the app name — the Grafana
  trace-to-logs key); `observe.environment`; `observe.capture` (`headers`, `bodies`, `frames`,
  `enduser`, all off; secrets redacted by ONE key list (std:fetch `SENSITIVE_KEYS`; `capture.sensitiveKeys` replaces it) — headers, query parameters and the keys
  of JSON bodies / ws frames / multipart fields at any depth: password, token, access/refresh
  token, secret, api key, authorization, cookie, session, …); `observe.processLogs`;
  `errors.expose: 'chain'` (the error envelope keeps its public fields `error`, `message`,
  `causes`, `status`, `requestId`, `traceId` with plain string causes — the code's own, the plugin
  runtime's location labels and the kernel's `action:<svc>.<act> span:<id> req:<id>` breadcrumbs
  (as at HEAD), never the `remote: <op> @ <service> span <id8>` ones a carrier hop added; the
  nested failures and those remote causes join `causes`, JsonCodec-encoded,
  stackless, only when exposed or trusted). A caller whose
  `tracestate` carries `ozaco=1` is continued but never trusted; carriers always continue and
  honour the sampled flag. Handlers: `ctx.log.*` (ONE record on the active span, debug included,
  also forwarded to the std Logger with the binding `ozaco.telemetry='sent'`),
  `ctx.span(name, body, { kind, attributes, links })`, `ctx.event(name, attributes, { time })`,
  `ctx.trace` (`traceId`, `spanId`, `requestId`); `Server.actions.span` / `.report({ stream })` /
  `.process(item, body)`; each `Server.actions.events()` item puts an `event.recv` span event
  (`messaging.message.id`) on the reading span and links its `publish` span (`creation`, the
  first 32 items); raw handlers get `{ principal, span }`. Plugin-owned routes and services
  (`/_health`, Docs, the observe console, static files) record `'errors'` only
  (`RawRoute.observe: 'off' | 'errors' | 'on'`); plugins write dispatch-level attributes through
  `dispatchSpan()` (`server:internal`), never `current()`. A failure is recorded ONCE per trace,
  where it originated, when it SETTLES: 5xx ⇒ span error + ERROR record, 4xx ⇒ status unset +
  `error.type` + WARN, handled (retried, fallen back) ⇒ `error.type` only, status unset on every
  span, CLIENT included; each recorded exception record (WARN+) is also handed to the std Logger
  (failure attached, bound `ozaco.telemetry='sent'`), so the console shows it. WS: the upgrade
  span carries `ozaco.ws.session.id`, every frame root `http.route` + the session id + link
  `ws.session`. Attribute keys match `^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$` (first segment a
  semconv namespace or `ozaco`), span event names stay ≤ 20 chars (Grafana cuts longer ones) and carry no `ozaco.` prefix (`breaker`, `cache.evict`, `ws.send`),
  link reasons ride `ozaco.link.reason`. `createServer` installs a `TraceTransport` when observing
  and none is visible; recommended: `DefaultLogger` + `ConsoleTransport` + `TraceTransport` at
  the ROOT (the node then claims the process's records, `observe.processLogs`).
  `ObservePlugin.use({ console, auth, capture, selfTrace, retention, batch, cluster })` stores
  `_ob2_spans` / `_ob2_logs` (no content switches) behind
  `/_observe/api/{traces,trace/:id,request/:id,stats,cluster,live}` — `auth` (the action option's
  shapes, needs `Auth`) gates that API, the `/_observe` page is a public shell that asks for a
  bearer. Real backends:
  `moon run server:test-observe` (docker: otel-lgtm + OpenObserve). See
  `packages/server/README.md`.
- **`@ozaco/client`** – the manifest-driven typed client for a `@ozaco/server` node. Every `$` key
  belongs to the client (unknown ones are `undefined`, never a service); `client.$scope` is the
  scope its IO/codec/ws contexts live in (`client.$scope.run(function* () { yield* client.x.y() })`); a
  manifest HTTP failure decodes like an action reply (bare 401/403 → `client.refused`) — the
  public `failureOf(response, requestId, { refused, prefix, remote })` does it for the runtime AND
  codegen's `pull(url, { token })` (the body read through JsonCodec — the nested failures a trusting server sends
  come back as real Failures (tag, message, causes — no native Error, no `raw`, no stack ever
  leaves a node over HTTP) — then an ozaco reply's `remote: <op> @ <service> span <id8>` cause, the `req:`/`status:`
  causes last; `remote.recordedIn` marks it recorded remotely in the caller's trace) — only a
  failed round trip is `client.network` (the platform rejection folded by the `network` matcher of
  `ClientErrors` — message = the platform code, else its message, the platform error its `raw`,
  the operation (`manifest`, the action id) a string cause; `pull`'s too). When tracing
  is on where a call runs, the call is ONE CLIENT span `{METHOD} {route}` (scope `@ozaco/client`, http client keys, `url.template`) that injects
  `traceparent` + `tracestate: ozaco=1` and ends after decoding / at stream end; tracing off ⇒ no
  span, the ambient context passes through. `$lastTraceId()` / `Meta.traceId` come from
  `traceresponse`; a failure the server already recorded in the call's trace is
  `markRecorded(…, { remote: true })` — it only marks the span (`ozaco.failure.remote`).
  Realtime: the context rides the upgrade, the `{ t: 'auth' }` frame and every `watch` frame; a
  redial re-sends frames with `reconnect: <traceparent>` only (the server opens a fresh root linked
  `ws.reconnect`); an error frame's `recorded` names the span that recorded it
- **`@ozaco/ai`**, **`@ozaco/cli`** – AI providers and the CLI toolkit. cli: a trailing array
  `args` field takes every remaining positional (a surplus one fails `cli.parse`); `ctx['--']` is
  the passthrough and flags are not scanned past `--`; `defineCommand({ input, short, examples })`
  options are inherited by every descendant action and `ctx.cwd` is read at run time; an action
  types them into `ctx` with the type-only `defineAction({ inherits: rootInput | spec, … })` (own
  field wins; a nested command's `inherits` accumulates its ancestors; `actions` expecting more than
  the command passes down is a type error — prefer the schema across files, no import cycle);
  `Registry.actions.run(argv, { report: true })` prints a failure once (`isReported(f)` →
  `CliCauses.Reported`), parse errors + help go to stderr
  (`Terminal.actions.write(text, { stream: 'stderr' })`); non-tty tables buffer until `end()` and fit every row; table handles
  have `remove`/`replace`
- `apps/panel` (docs try-it UI) and `apps/observe` (dev console) are embedded into the server's
  `Docs` / `ObservePlugin`; `examples/demo` is the end-to-end reference app.

**Workspaces** (root `package.json`): `packages/`, `plugins/`, `apps/`, `tools/`, `experiments/`,
`examples/` — only `packages/`, `apps/` and `examples/` exist on disk today.

### @ozaco/std Modules

The core package exports these modules via path aliases (e.g., `std:result`, `std:logger`). Every
plugin installs with `yield* Plugin.use(...args)` (`yield* JsonCodec.use()`,
`yield* WsClient.use({ codec })`) — there is no `install()`. Error tags AND cause names are
`createTags` bundles with dotted values, one per module, exported from the module barrel
(`ResultErrors`, `EffectErrors`/`EffectCauses`, `PluginErrors`, `SchemaErrors`, `CodecErrors`, `ConfigErrors`,
`TraceErrors`/`TraceCauses`, `IOErrors`/`IOCauses`, `FetchErrors`, `WsErrors`/`WsCauses`, `RtcErrors`/`RtcCauses`; server adds
`AuthErrors`/`AuthCauses`, `ResilienceCauses` and `serviceErrors(...)` on top; `WsErrors.Connect`
is `'std:ws.connect'`). Never pass a bare string as a tag or a cause — `fail(XErrors.Tag, message,
...XCauses)` and `guard(fn, XCauses.Step)`; tests assert the dotted literal or the bundle
member. To substitute a platform implementation, implement the protocol (`Ws.implement(...)`,
`Rtc.implement(...)`) — never an `impl` option (see `tests/ws/helpers.ts` `wsMock`,
`tests/webrtc/fake.ts` `rtcMock`). Plugin/protocol names all start with `std/`
(`std/io`, `std/bun-io`, `std/trace`, `std/logger`, `std/default-logger`, `std/console-transport`,
`std/file-transport`, `std/trace-transport`, `std/fetch`, `std/fetch-client`, `std/ws`, `std/ws-client`, `std/webrtc`, `std/webrtc-client`, …). Retry
budgets and re-armed gates are `std:effect` primitives (`budgetOf`/`budgetDelay`/`BUDGET_DEFAULTS`,
`createGate`), frame-decoding subscriptions come from `Codec.actions.decodeFrames` — ws and webrtc
share them instead of re-implementing them.
std has no README: how a module works underneath is in the doc comments of its `definition.ts` /
`utils/*.ts` and in its `tests/<module>/` suite; std:trace end to end is the Observe section of
`packages/server/README.md`.

- **result** - `Result<T,E>` / `Maybe` types with `fail`, `succeed`, `appendCauses`, `asFailure`, `lazyPromise`/`lazyPromiseWithResolvers`, `formatFailure`, `auto`, `throwable`, `unwrap`, `just`, `nothing` and the `is*` guards (`isSuccess`/`isFailure`/`isResult`/`isJust`/`isNothing`/`isMaybe`); no `map`/`orElse`/`pipe` here. A Failure is `{ _t, error, message, causes, _d, raw? }`: `causes` is `Result.Cause[]` (`string | Result.Failure<unknown>`) and carries the WHOLE chain; `raw` is the foreign value (a thrown JS / platform / third-party error) a fold came from — ONLY `asFailure` sets it, it is the caller's to inspect, std never renders, sends or classifies by it (no JS stack is rendered anywhere, no `thrownOf`). `asFailure(value, Bundle?, ...causes)`: a Failure passes through; a foreign value is folded, kept as `raw`, into the first tag of `Bundle` (a `createTags` bundle, see shared) whose matcher recognizes it (message: a function matcher's string, else the value's own `message`, else `code`), else into `ResultErrors.Unknown` = `std:result.unknown` (its `serializeError` text the message); a `std:result.unknown` fold with `raw` given a Bundle is RE-CLASSIFIED (a new failure, causes and raw kept) — how module code classifies what the effect runtime folded (`until`, `attempt`, `guard`). `throwable(cb, Bundle?, ...causes)` folds a throw / rejection the same way. `fail(tag, message?, ...causes)` / `appendCauses(result, ...causes)` (in place, a promise too) take `ResultDef.CauseInput` (`string | Result | null | undefined`): a string stays, a Failure / failed Result is nested as the SAME object (std:trace's record-once keys on identity), a Success / `null` / `undefined` is dropped — a native Error is never a cause (an untyped caller's is folded by `asFailure` as a safety net). So the rewrap is `fail(Tag, msg, inner)`; at an operation boundary `fail(OpTag, '<what we were doing>', asFailure(error, ModuleErrors))`; never `new Error(…)`, never spread `...inner.causes` or `String(error)` into a new failure, never `Object.assign(f, { cause })` (`tests/result/rewrap.test.ts` scans the packages' `src`). `formatFailure` (`tag: message: cause > cause`, a nested failure inline as `(tag: message)` — the ONE failure formatter, the logger uses it; render a Failure with it, never with `serializeError`); `formatFailure(f, { chain: true })` is the multi-line Java-style chain — `<tag>: <message>`, a `    at <cause>` line per string cause, then each nested failure as a `Caused by: …` block, depth first; NO limit of any kind (no byte budget, no depth cap — every level and every cause; a failure met again is rendered once, so a cycle ends) (its `Level` shape lives in `ResultDef` — result has no `Helpers`, by the user's call). `main()` prints `formatFailure(asFailure(e), { chain: true })`
- **shared** - the bottom layer, it imports NO other std module (`tests/shared/layering.test.ts` pins it). Common types (`AnyType`, `EmptyType`, `Simplify`, `Tags`, `StandardSchemaV1`, exported `Helpers`) and utilities: `createTags` (an entry is a kebab name or `[name, matcher]` — `{ code }` / `{ name }` (one value or a list; both given: both must match) or a function `(value) => boolean | string` (a string is a match AND its message); the matchers ride a non-enumerable `TAG_MATCHERS` symbol, first match wins; `asFailure(value, bundle)` interprets them — shared only holds the data), `pipe`, `deepMerge`, path helpers (`getPath`/`setPath`/`unsetPath`/`flatten`/`flattenEntries`), `serializeError` (NOT Failure-aware), `hasFlag`, bytes (`toHex`/`toBase64`/`fromBase64`, no Buffer), semver (`compareVersions`/`satisfies`), the `TlsOptions` type, `PriorityQueue`, runtime guards (`isPromise`, `isArray`, …; `isResult` lives in `result`)
- **schema** - the `Result`-returning Standard Schema helpers that cannot live in `shared`: `validateSync(schema, value)` (`SchemaErrors.Validation` with one `path: message` cause per issue, `SchemaErrors.AsyncSchema`) and the `match(value).with/when/otherwise/exhaustive/run` builder (`MatchBuilder`, `Helpers.MatchCase`; `SchemaErrors.NoMatch`/`NonExhaustive`)
- **effect** - Effection-style structured concurrency: `Operation`, `Flow` (the effect stream abstraction — "stream" refers only to native platform streams), scopes, contexts, signals/channels/queues; `spawn` returns at once (the child may never start if the scope closes first), `fork` is guaranteed started before it returns and is supervised — use `fork`/`resource` when teardown must be armed; `attempt`/`recover`/`mapError` handle failures as values (`box` is gone); `within(scope, op)` runs an op in another scope's contexts while the caller owns it (its failure reaches only the caller; it halts with the caller or the scope — never `scope.run(op, { detached: true })` for this); coordination primitives are `createGate`, `createMutex`/`createSemaphore(n)` (FIFO, permit released on failure/halt) and `createBreaker({ failures, halfOpenMs })` (a terminal `trip` never half-opens); `EffectErrors` = breaker-open, halted, iteration-error, missing-context, no-scope-handler, using
- **event** - Typed event emitter (`createEvent`) plus effect bridges (`useEvent`, `onEvent`, `useEventOnce`, `useBufferedEvent`)
- **plugin** - Plugin architecture: protocols (`defineProtocol` with `handlers`/`defaults`/`exec`, `Protocol.implement(...).build(...)`), `definePlugin`, `Plugin.use`, contexts, `before`/`after`/`around`/`error` hooks; `PluginErrors` = missing-action, protocol-not-cloneable. A failure passing the runtime gets its location appended IN PLACE as string causes, inner hop first (the same Failure object reaches the caller): a handler `<key>:handler` + `<protocol>@<version>`, a default `<key>:default` + `<protocol>@<version>`, the dispatch `dispatch` + `<protocol>@<version>`, an impl/plugin action `<key>` + `<impl>@<version>`, `setup` `setup` + `<plugin>@<version>` (`guard(fn, ...labels)`; a returned Result is unwrapped); an `error` hook receives the Failure (a foreign throw already folded by `asFailure`), never the raw value; a throwing `error` hook's own Failure surfaces as the SAME object with a `masked: <tag>: <msg>` cause and the masked failure nested in its causes (`appendCauses`; skipped when the hook already wrapped it, nothing masked when it rethrows what it was given); hook types accept readonly-rest members
- **trace** - span lifecycle, W3C propagation and failure recording with NO exporter of its own, ALL behind the CLONEABLE `Trace` protocol (`std/trace`, `labels: false` — the plugin runtime adds no location labels to its failures): the barrel exports only `Trace`, `TraceSeverity`, `TraceErrors`/`TraceCauses` and types (`TraceDef.*`; the contexts, W3C parse/format and exception rendering are internal). Finished spans (`TraceDef.SpanData`) and log records (`TraceDef.LogData`, body never empty) go to every install (`TraceDef.SinkActions` `export`/`emit`, no-op defaults; one install failing never stops the others; an impl's `setup` calls `Trace.actions.enableTracing()`). `Trace.actions.*` (documented on `TraceDef.Handlers`): `span(name, options?, body)` (a Result the body returns is unwrapped by the runtime — `attempt(() => Trace.actions.span(…))` to get it back), `startSpan` (`LiveSpan.run/end`, end idempotent), `current()` (a no-op handle when none; `handle.valid` tells), `activeContext()`, `active()` (the active span as an opaque value), `passThrough(ctx | active, body)` (a context this node only forwards, or a span re-entered as it was — a stream produced after its dispatch returned), `detached(body)`, `activate(liveSpan | ctx | null)` → restore (a scope between frames), `event(name, attrs, { time, severity, body })` (a span event + one record with `otel.event.name`), `emitLog(input)` (`failure` + `omitRecorded`: THE one "log line reporting a failure" — recorded on a recording span at WARN+, else exception attributes + marked recorded), `recordFailure`, `settle(f, { status })`, `inject({ ozaco, context })` / `extract(getter | carrier)` (W3C trace-context level 2: invalid ⇒ `null`, never throws; `tracestate` validated; `ctx.ozaco` when it carries `ozaco=1`), `markRecorded(f, traceId, { remote?, spanId?, flags? })`/`isRecorded`/`recordedBy(f)` (per (failure, trace), registries on `globalThis`; `remote: true` — a decoder whose sender recorded it — is what gives the spans it escapes `ozaco.failure.remote = true`; `spanId` + `flags` name the remote recorder `recordedBy` answers), `suppressed(body)`/`isSuppressed()` (no spans, no records, outgoing sampled bit cleared), `isTracing`, `canEmit`, `traceNow`, `newTraceId`/`newSpanId`, `useIds(ids)` (pin ids in tests), `registerFallback(sink)` (the process-level record sink an observing server claims), `toAttributes`. `SpanOptions`: `kind`, `scope` (none given ⇒ the span's service, else a local parent's scope that is not `@ozaco/…`, else `app` — never `@ozaco/std`), `service` (inherited), `attributes`, `links`, `parent` (`null` = new trace), `sampled`, `requireParent` (no recording parent ⇒ no span), `record: 'errors'` (a local root exported only when something failed), `failure: { status, type, eventName, handledSeverity }` (outermost classifier wins). Tracing off ⇒ the body runs with a no-op handle, nothing is minted, a pass-through context still propagates. Values: primitives or homogeneous primitive arrays — objects flattened to dotted keys (3 levels), deeper ⇒ capped JSON string, non-finite numbers ⇒ `'NaN'`/`'Infinity'`/`'-Infinity'`, strings ≤ 2048 UTF-8 bytes, arrays ≤ 128 items, ≤ 128 attributes/events/links per span (the GENERIC limits: an unbounded chain still makes a bounded record — `tests/trace/unbounded.test.ts`; every chain walk is iterative, so no depth overflows the stack). HOLD-UNTIL-SETTLED: a failure escaping a span is held until it settles (a reply encoder's `settle`, an ancestor that handled it, or the local root ending), then recorded ONCE per trace at its ORIGIN span: one `exception` span event (the whole chain as `exception.stacktrace` — its values under the span value cap like every event's) + one LogData (`eventName` = the origin's `failure.eventName` else `exception`, body = the chain (the log record's generic value cap still applies), `exception.type/message/stacktrace`, `ozaco.failure.chain` = `type: message` of the failure then every failure nested in its `causes`, depth first, all of them, `ozaco.failure.causes` = its own string causes, left out when there are none — an empty array is never emitted); every held span gets `error.type`, status error (message = `exception.message` = the failure's message) only at ≥ 500 (4xx: CLIENT spans only; a HANDLED failure never sets a status, CLIENT spans included); severity 17 for ≥ 500, 13 below or handled, 5 cancelled; a failure nested anywhere in a wrapping one's `causes` is absorbed by it; a halted span gets `ozaco.cancelled`. Span events are exported sorted by time (stable), so every sink shows one order; timestamps come from ONE process-wide sub-ms clock anchored at `performance.timeOrigin` (re-anchored while it drifts > 1 s from `Date.now()`, e.g. after sleep), so a child never starts before its parent. A sink's `emit` (and a fallback sink) runs with the record's own span active as a pass-through, so a Logger line it writes carries that `trace`. `TraceErrors` = tracer; `TraceCauses` = export, emit. The model end to end (what each backend shows, queries) is the Observe section of `packages/server/README.md`
- **codec** - Codec protocol with `JsonCodec`/`TomlCodec`/`YamlCodec` impls (`encode`/`decode`, `stringify`/`parse`, `encodeFlow`/`decodeFlow`) plus the `encodeFrame`/`decodeFrame` protocol handlers used by ws/webrtc; JsonCodec is THE wire for failures (every encode/decode, stringify/parse and flow): a Failure anywhere in the value is written `{ _t: 'std:result:failure', error, message, causes }` (`_d` and `raw` stay home, nested failures recursively, 64 deep, cycle cut) and rebuilt on decode as a real one (`isFailure`, iterable); no native Error is written or rebuilt (JSON renders one `{}`); a cheap scan skips the replacer for values holding no Failure; a codec failure is ONE level — the operation's tag, the parser / serializer's own message, the thrown value its `raw` (`asFailure(error, PARSE_FOLD)`, never a nested `std:result.unknown`); a BARE top-level Failure given to `Codec.actions.decode/parse` is raised (the plugin runtime unwraps returned Results — `attempt` gets it as a value), so a wire puts a failure inside an envelope object; `CodecErrors` incl. `AlreadyRegistered` (only a DIFFERENT impl — another `name@version` tag — claiming a taken name; re-installing the same tag, e.g. in a child scope or from a second copy of the same std release, is a no-op); `YamlCodec` exists but nothing in the monorepo uses it
- **config** - Config discovery/merge/edit/watch plugin: `Config.use(options)` builds the context only, `Config.actions.load()` discovers; needs an IO impl + the file codec (default `TomlCodec`) installed; `JsonCodec` is required only by `watch` (change-detection fingerprint); `Features` bitflags from bit 0 (FILE=1, CHAIN=2, VARIANT=4, ENV=8, DIR=16); the `path` option / `Config.actions.open({ path, codec })` loads exactly one file (its `extends` still resolve, no discovery); `ConfigErrors.MissingExtends`
- **io** - Platform IO protocol (`BunIO`/`NodeIO`/`WebIO`; every type lives in the `IODef` namespace of `types/io.ts` — `IODef.Actions` is the contract, `IODef.S3Options`, `IODef.WatchEvent`, … the shapes): fs (`IO_FLAGS` from bit 0, camelCase keys: followSymlinks=1, files=2, dirs=4, append=8, exclusive=16), flows, path helpers, processes (`spawn(…, { stdio: 'inherit' | 'pipe' | { stdin, stdout, stderr } })`, `toTerminal(flow, { stream })`, the `decodeText(flow)` util decodes chunk-split UTF-8), net (TCP sockets are half-open: a peer FIN ends only `data`, the socket stays writable; `end()` half-closes, `close()` tears down, `closed` settles when the socket is gone), env/ip/tmpdir/cwd/homeDir, `platform()` (`{ os, arch, uid? }`), `expandHome(path)`, crypto (`hash(…, { encoding: 'hex' | 'base64' })` returns a string), `ulid`/`uuid`/`hlc`, watch (Watchman preferred, `STD_WATCHMAN=off` disables it, `fs.watch` fallback), S3 (Bun native / Node SigV4-over-fetch / Web unsupported; reads stream via `file.stream()`, a `ReadableStream` body streams up as a multipart upload with `partSize` parts — Bun's `writer()` sink, the fetch client's own multipart path); `internal/` is grouped by domain: `crypto/` (node, web, ulid, uuid, hlc), `fs/` (flow, walk, watch), `stream/` (from-readable, to-readable), `path/` (node, web, home — `createExpandHome`), `process/` (shared, bun, node), `net/` (sockets, sys), `s3/` (config, sign, transport, xml, multipart, fetch, create); `IOErrors` = unsupported, not-found (`ENOENT`), exists (`EEXIST`), access-denied (`EACCES`/`EPERM`) — those three carry matchers: every fs rejection goes through `fsCall` (`asFailure(error, IOErrors)`) — missing-env, exec-failed, exec-spawn-failed, spawn-failed, process-error, kill-failed, stdin-write-failed, sign-failed, verify-failed, hlc-invalid, decrypt-failed, s3-failed, tcp-listen-failed, tcp-connect-failed, tcp-write-failed, udp-bind-failed, udp-send-failed; a platform failure under an operation tag is `fail(IOErrors.TcpConnectFailed, 'tcp connect to host:port failed', asFailure(error, IOErrors))`; `IOCauses` = stream, write-stream
- **logger** - `Logger` (impl `DefaultLogger`, also at `std:logger/impl/default`) + cloneable `LoggerTransport` fan-out (`std:logger/transport/console`, `std:logger/transport/file`, `std:logger/transport/trace`); both file/console default formats pin `JsonCodec`; `ConsoleTransport` reads the logger context in `setup`, so install it after `DefaultLogger`. An entry carries `trace` (`{ traceId, spanId, flags }` of the active — even pass-through — span) and `failures` (every Error / Failure of the payload: a bare Error folds by `asFailure` (the same Error or Failure given twice is two failures) — one under the error key / `err` / `error` is lifted out of `data`, nested ones render in place; `error` = the first one's one-liner); JSON records add `trace_id`/`span_id`/`trace_flags` (reserved keys win — a colliding user key moves to `data.<key>`), the pretty console prints `trace=<8 hex>` and each failure in ONE form (a one-line one as `err=`, else only its chain block, indented). `TraceTransport.use({ level? })` turns every entry into ONE std:trace LogData (severity TRACE 1/DEBUG 5/INFO 9/WARN 13/ERROR 17/FATAL 21 + `severityText`, body = msg, scope = the `logger` binding, bindings + data flattened ≤ 64 leaves else one `ozaco.log.data` JSON, backend-reserved keys moved to `ozaco.data.<key>`; the entry's first failure rides `Trace.actions.emitLog({ failure })` — recorded on a recording span at WARN+, one exception per trace); it skips entries bound `ozaco.telemetry='sent'` (already emitted by the server's `ctx.log`) and, where tracing is off, hands the record to the process fallback (`Trace.actions.registerFallback`). Install it ONCE at the root next to `ConsoleTransport` (a re-install in a child scope replaces the inherited one)
- **fetch** - HTTP client protocol `Fetch` + impl `FetchClient.use({ baseUrl, headers, timeoutMs, codec })`; two-step response API (no builders): `const res = yield* Fetch.actions.get(url)` then `yield* res.json()` / `res.expect()`; verb shorthands call the pinned `FetchClient.actions.request` (hooks still wrap, so `Fetch.around({ request })` sees every call); platform call injectable via the `fetchImpl` context; `tls` (`TlsOptions`) per request or as the install default; `FetchErrors` = timeout, http-status, parse, network — `timeout` / `network` carry matchers: a rejected platform fetch is folded by `asFailure(error, FetchErrors)` (network: a transport fault, message = the platform code, e.g. `ConnectionRefused`, else its message, the platform error its `raw`; timeout: `<target>: timed out after Nms` over the runtime's fold). With tracing on, every `FetchClient` request is a CLIENT span `{METHOD}` or `{METHOD} {template}` (per-request `template` ⇒ `url.template`; scope `@ozaco/std/fetch`; `url.full` redacted by `redactUrl`/`redactQuery`/`isSensitiveKey` — credentials and the values of the `SENSITIVE_KEYS` query keys (signature/token/key/session/…), `FetchClient.use({ sensitiveKeys })` replaces the list; ≥ 400 ⇒ status error + `error.type`; `resendCount` ⇒ `http.request.resend_count`) that ends when the body is read, streamed or cancelled (an unread one when the calling scope closes) and injects `traceparent` + `tracestate: ozaco=1` (a caller-set `traceparent` wins; `propagate: false` per request or at install opts out); tracing off ⇒ no span, a pass-through context still goes out
- **ws** - WebSocket protocol `Ws` (routed `Ws.actions.connect`, hooks via `Ws.around({ connect })`) + impl `WsClient.use({ codec, reconnect, keepalive, … })`; `connect` (takes `tls` too) returns a scope-bound resource with optional auto-`reconnect` (one continuous `messages` Flow across generations) and `keepalive`; `WsClient` constructs sockets with `globalThis.WebSocket`, read at connect time (no `WebSocket` global → `WsErrors.Unsupported`); a mock implements the protocol (`Ws.implement(...).build({ connect })`, see `tests/ws/helpers.ts` `wsMock`); `WsErrors` = connect, unsupported, reconnect-exhausted; `WsCauses` = connect, dial, send, close, keepalive, reconnect
- **webrtc** - WebRTC protocol `Rtc` (routed `Rtc.actions.connect`, hooks via `Rtc.around({ connect })`) + impl `RtcClient.use(defaults?)` (client AND server — the API is peer-symmetric): `Rtc.actions.connect(signal, options)` negotiates over any `{ send, messages }` duplex (a `Ws` connection qualifies) and returns a scope-bound peer; data channels are Flow-based with backpressure-aware `send`, ICE restarts (`iceRestart`) and whole-session redials (`reconnect`, ws-style — local channels/tracks survive) are supervised; typed media via `peer.addTrack` → `Sender` + remote `tracks` Flow (browser-first — impl without `addTrack` fails `RtcErrors.Unsupported`); `RtcClient` resolves `RTCPeerConnection` at connect time (the browser global, else the auto-imported `node-datachannel` polyfill on Bun/Node, else `RtcErrors.Unsupported`); a mock implements the protocol (`Rtc.implement(...).build({ connect })`, see `tests/webrtc/fake.ts` `rtcMock`); observability is always on — `peer.metrics` (session counters), a bounded `peer.timeline` plus the live `peer.events` Flow (kinds: dial/state/offer/answer/glare/candidate/channel/track/ice-restart/redial/stats/close/error), and `peer.stats()` normalizing the impl's `getStats` (`observe: { sampleMs, timeline }` sizes it and turns the sampler on); `RtcErrors` = unsupported, connect, connection, negotiation, signal, ice-exhausted, reconnect-exhausted, channel, timeout, track, stats; `RtcCauses` names every pump/supervisor/handle operation

### Key Patterns

- **Error handling:** Use Result helpers (`fail`, `succeed`, `appendCauses`, `asFailure`) with the module's `*Errors` tag bundle, avoid bare throws; no native Error anywhere — never `new Error(…)`, never read a foreign error's fields outside a matcher: a third-party / JS error maps to a tag through a `[name, matcher]` entry of that module's `errors.ts` and `asFailure(error, ModuleErrors)` (unmatched → `std:result.unknown`, the value its `raw`); rewrap with `fail(Tag, message, inner)` — the inner Failure is nested in `causes` as is, so the chain survives; never flatten an inner failure into strings (`...inner.causes`, `String(error)`)
- **Telemetry:** instrument through `Trace.actions.*` (`span`, `current()`, `event`, `recordFailure`, `emitLog`), never a hand-rolled record; operational lines go through the std Logger with a `logger: '@ozaco/<package>[/<part>]'` binding (it becomes the instrumentation scope); code that talks to a telemetry backend runs `suppressed()`
- **Exports:** `const` arrows; generator actions/helpers must be `function*` declarations (`guard(function* …, ...causes)` ONLY when causes are passed — never to fold throws, that is `throwable`); keep modules side-effect free, re-export through `index.ts` barrels (`types/helpers.ts` always via `export type *`)
- **Layout:** module root holds `definition.ts` (`definitions.ts` only when several protocols live there, e.g. logger), `errors.ts`, `index.ts`, `types(.ts|/)`, `internal/`, `utils/`; `const.ts` at the root only when the barrel exports it, otherwise `internal/const.ts`; sub-path implementations live under `impl/` (`std:codec/impl/json`, `std:logger/impl/default`, `std:io/impl/bun`) or `transport/` (logger); `effect/base/` is the one sanctioned extra root directory — the primitives its `utils/` build on; `utils/*.ts` hold public exports only and no `internal/` / `utils/` file declares a type (see New utilities — `types/helpers.ts` `Helpers`); the same holds in every package (server/db/transport/client/cli/ai) and `examples/demo`
- **Async:** Use `isPromise`/`isResult` helpers, return promises instead of mixing await with mutation
- **Immutability:** Default immutable, mutate only when APIs require it (e.g., pushing into `failure.causes`)
- **New utilities:** public helpers go in `packages/std/src/<module>/utils/` and are exported from the barrel immediately; module-private helpers (functions, classes, constants) go in `<module>/internal/` — never next to a public export in a `utils/*.ts` file — and are never imported from outside the module. A type / interface an `internal/` or `utils/` file needs is never declared there: it lives in `<module>/types/helpers.ts` under `Helpers` (barrel: `export type * from './types/helpers'`)

## Code Style

OXC is canonical (oxlint + oxfmt): 2 spaces, width 100, single quotes, JSX single quotes, trailing commas `all`, no semicolons.

- **Import order:** external packages → `std:*` aliases → relatives
- **Use `import type`** for type-only imports
- **Naming:** camelCase values, PascalCase types, SCREAMING_SNAKE_CASE for shared constants; type namespaces are `<Module>Def` (consumer-facing), `Utils` (public utils' types), `Helpers` (internal shapes, still exported)
- **TypeScript:** Honor `tsconfig.base.json` strictness (no relaxing `strict`, `verbatimModuleSyntax`)
  — every package's `tsconfig.paths.json` MUST `extends: "../../tsconfig.base.json"` (the package
  `tsconfig.json` extends the paths file); without it the project has no `target`/`strict` and the
  editor reports ts2802 on every `yield*` (std lacked it until 2026-09-17)
- **Builds:** a tsdown config with external resolvers passes
  `inputOptions: withDeclarationPlugins()` (devkit; one resolver for every ozaco family) — tsdown runs the `.d.cts` pass WITHOUT user plugins,
  so the CJS types otherwise leak `std:*` aliases or inline private copies of std's types
  (`devkit/tests/published-types.test.ts` checks both)
