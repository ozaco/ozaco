# @ozaco/server

A service/action kernel. You declare **services**, each holding **actions** with a schema in and a
schema out; `createServer` turns them into a node — HTTP routes, WebSocket routes, cross-node RPC,
tracing, auth, cache and docs all fall out of the same declarations.

```
service ──▶ action ──▶ dispatch
                         │
   edge (HTTP/WS) ───────┤        plugins wrap every dispatch
   carrier (other nodes) ─┘        (auth, cache, resilience, observe)
```

One action is reachable three ways with no extra work: over HTTP at its route, from another node
over the carrier, and in-process through `ctx.call(service, 'action', input)` — typed end to end.

## The smallest server

```ts
import { column, DbClient, defineSchema, table, useDb } from '@ozaco/db'
import { MemoryAdapter } from '@ozaco/db/impl/memory'
import { action, createServer, service } from '@ozaco/server'
import { BunEdge } from '@ozaco/server/edge/bun'
import { main, suspend } from '@ozaco/std/effect'
import { BunIO } from '@ozaco/std/io/impl/bun'
import { z } from 'zod'

const todosTable = table('todos', {
  title: column.text(),
  done: column.boolean().default(() => false),
})

const schema = defineSchema({ todosTable })

const Todo = z.object({ title: z.string(), done: z.boolean() })

const todos = service('todos', {
  list: action.query({ output: z.array(Todo) }, function* () {
    return yield* (yield* useDb(schema)).query('todos').collect()
  }),

  add: action.mutation(
    { input: z.object({ title: z.string().min(1) }), output: Todo },
    function* ({ input }) {
      return yield* (yield* useDb(schema)).insert('todos', { title: input.title })
    },
  ),
})

await main(function* () {
  yield* BunIO.use()
  yield* MemoryAdapter.use()
  yield* DbClient.use({ schema })

  const server = yield* createServer({ services: [todos], edge: BunEdge, listen: { port: 3000 } })
  const info = yield* server.start()

  console.log(`listening on ${info.url}`)
  yield* suspend()
})
```

`GET /todos/list` and `POST /todos/add` are live. `@ozaco/server/plugins`'s `Docs` adds
`/docs` (a try-it panel) and `/docs/openapi.json` from the same declarations.

## Defining

|                                                          |                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service(name, actions, options?)`                       | a named group of actions; routes default to `/<service>/<action>`. `options.auth` is the requirement of every action that sets none of its own (`auth: false` opens one up)                                                                                                                                                              |
| `action.query` / `.mutation` / `.action` / `.stream`     | the kind fixes the default HTTP method (GET / POST / POST / GET), the manifest entry and how a client decodes it                                                                                                                                                                                                                         |
| `action.socket(config, handler)`                         | a WebSocket route declared inside the service                                                                                                                                                                                                                                                                                            |
| `crud(table, options?)`                                  | a whole REST resource **as a service** — list/get/create/update/replace/remove plus a delta-watch socket. Goes straight into `services: [...]`. `schema` transforms reshape the derived schemas **in the types too**; `scope` is the trusted per-caller filter (tenancy, optionally `{ read, write }`); `ops` sets per-op options/errors |
| `serviceErrors(prefix, statuses)`                        | the failure taxonomy in one place: `errors: media.statuses` on the action, `yield* media.notFound(...)` in the handler. Any status goes — a tag mapped to `200` still answers the `{ error }` envelope, flagged by the `oz-error` header (rpc-style), and the client still sees a failure                                                |
| `stream.ndjson` / `.sse` / `.text` / `.bytes` / `.parts` | branded input/output planes; a stream handler may answer with an array, an async iterable, a `flowOf(...)` Flow or a branded stream                                                                                                                                                                                                      |

A handler's answer is validated against its `output` schema too: a mismatch is the server's
bug, so it fails `server.output` (500) — `server.validation` (400) is reserved for what the caller
sent.

An action's config carries the plugin options as **typed fields** — `auth`, `cache`, `invalidate`,
`timeoutMs`, `retry`, `breaker`, `bulkhead`, `singleflight`, `rateLimit`, `fallback`. An unknown key
is a compile error, and a configuration failure at `createServer` if the owning plugin is not
installed.

## Raw routes and static files

Outside the action model the edge serves plain `Request → Response` routes and whole directories:

```ts
function* mountExtras() {
  yield* Edge.actions.raw({
    method: 'GET',
    path: '/whoami',
    auth: 'authenticated', // omitted = Auth's `default`; `false` = public
    // `span` is the request's edge span (attributes / events of your own)
    *handler(request, params, { principal, span }) {
      span.setAttribute('app.whoami.known', principal !== null)
      return Response.json({ sub: principal?.sub ?? null })
    },
  })

  // GET + HEAD under /assets: content-type by extension, index.html for directories, 404 for
  // missing files and dot-files, `..` / encoded escapes and symlinks refused (`followSymlinks: true`)
  yield* Edge.actions.static({ path: '/assets/**', dir: 'public', auth: false })
}
```

Raw routes go through the **same gate as actions**: with `Auth` installed, a route's `auth` (the
action option's shapes) or else `Auth`'s `default` decides — a fail-closed node
(`default: 'authenticated'`) keeps raw routes and static files closed too, and the verified
principal reaches the handler as `{ principal }`. A public route (`auth: false`) is served
anonymously even when the bearer it carries is stale. Without `Auth`, a route asking for anything
but `false` is refused (401). The built-in routes are public on purpose — `/_health` (probes),
`/_observe` (the console shell; its data rides the `observe` service, gated by
`ObservePlugin.use({ auth })`) and the `Docs` routes unless `Docs.use({ auth })` gates them.

For a seam of your own, `Auth.actions.authorize(requirement, headers)` raises
(`server.unauthorized` / `server.forbidden`) and `Auth.actions.check(requirement, headers)` answers
the principal or `null` instead — both take a `Headers` or a record in any casing.

A raw route is traced like any request (`observe: 'on'`, the default); `observe: 'errors'` keeps
its span only when the request fails and `'off'` never traces it. Static files, `/_health`, the
`Docs` routes and the observe console default to `'errors'` — probes and page loads leave nothing
behind unless they break.

## `ctx`

The one argument every handler gets, next to `input`:

| field                                            |                                                                                                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requestId`, `spanId`, `trace`                   | the ids this dispatch runs under — `trace` is `{ traceId, spanId, requestId }` (`''` span ids when nothing is traced)                              |
| `service`, `action`, `meta`                      | what is running                                                                                                                                    |
| `auth`                                           | the verified `Principal`, or `null`                                                                                                                |
| `log.debug/info/warn/error(msg, data?)`          | ONE log record correlated to the active span (debug included, whatever the Logger's level), also forwarded to the std Logger when one is installed |
| `signal`                                         | aborted when the caller leaves or the deadline passes                                                                                              |
| `headers`                                        | edge headers / socket handshake / carrier meta                                                                                                     |
| `call(service, 'action', input, options?)`       | another action — local or over the carrier, typed from the definition                                                                              |
| `call(ref, input, options?)`                     | the same, by ref (`server.api.todos.list`, `refs<typeof todos>('todos').list`)                                                                     |
| `emit(name, payload)`                            | an event every node hears (a `publish {name}` PRODUCER span)                                                                                       |
| `span(name, body, { kind, attributes, links }?)` | a child span of the active one; `body` gets its handle                                                                                             |
| `event(name, attributes?, { time }?)`            | a span event on the active span + one log record (`time` replays a timeline)                                                                       |
| `reply({ status, headers })`                     | shape this call's successful edge reply — through a gateway too: the owner's status and headers (a `Location`) cross the carrier with the value    |

The database and the cache are **not** mirrored on `ctx`: reach them where they live —
`yield* useDb(...tables)` (typed by your tables) and `Kv.actions`, both from `@ozaco/db`.

## Plugins

Installed in order through `createServer({ plugins })`; their dispatch hooks wrap in that order.

| plugin                                                                                                     | needs installed first                                              | gives                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JwtAuth.use({ provider, secret \| keys, mode })` · `StaticAuth.use({ tokens })` · `Auth.use({ default })` | strategies BEFORE `Auth`                                           | `Auth` is the gate: the `auth` action option, `ctx.auth`, `login` / `refresh` / `verify` / `signService` routed to the strategies — several `AuthStrategy` impls run side by side, the first SUCCESSFUL answer wins (`AuthStrategy.implement(...)` for SSO / API keys of your own); `default` is what an action or raw route without `auth` requires (`'authenticated'` = fail-closed)                                                                                                                                                                    |
| `Cache`                                                                                                    | a `Kv` (`MemoryKv` / `RedisKv` / `TableKv`)                        | the `cache` and `invalidate` options, table-change invalidation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `Resilience`                                                                                               | —                                                                  | `timeoutMs`, `retry`, `breaker`, `bulkhead`, `singleflight`, `rateLimit`, `fallback`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Cors.use({ origins })`                                                                                    | an edge                                                            | CORS headers and preflight (a `Bun.file` body keeps its content-type)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Docs.use({ path, auth })`                                                                                 | an edge (`Auth` for `auth`)                                        | the manifest, OpenAPI 3.1 and the try-it panel; `auth` gates all three behind a bearer                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ObservePlugin.use({ console, auth, capture, selfTrace, retention, cluster })`                             | a `DbClient` (a `NetworkCarrier` for `cluster`, `Auth` for `auth`) | the spans and log records every exporter receives, as db rows; the `/_observe` console; `auth` gates its API — see [Observe](#observe)                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `StdoutExporter` · `OtlpExporter.use({ url })` · `OpenObserveExporter.use({ url, org, auth })`             | —                                                                  | `ObserveExporter` impls: where the spans and log records are SHIPPED — install any number of DIFFERENT exporters side by side (with or without `ObservePlugin`), the kernel fans every record out to all of them, starts them with the node and flushes them at stop; one install per exporter (a second `OtlpExporter.use()` replaces the first), so a second OTLP destination is an `ObserveExporter.implement(...)` over `createOtlpPipeline` — the way `OpenObserveExporter` is built; `ObserveExporter.implement(...)` for a destination of your own |
| `HotReload.use({ entry, watch })`                                                                          | —                                                                  | dev only: re-evaluates the service modules on save and swaps them in (`reload`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

`NetworkCarrier` needs a transport (`MemoryTransport` / `NatsTransport` / `RedisTransport`)
installed before it.

## Hot reload

A running node can swap its declarations without going down: `server.reload(services)` (also
`Server.actions.reload`) rebuilds the registry, remounts the edge's routes and re-serves the
carrier — the port stays open, sockets stay connected, the database and the transport keep
their sessions, in-flight dispatches finish on the definitions they started with. The swap is
atomic: a duplicate service name or an option no plugin handles fails `server.configuration`
and nothing changes. It resolves what changed (`added` / `removed` / `replaced`), and every
plugin's `reload` hook sees the same report.

`HotReload` (plugins) drives it from the file system in development:

```ts
createServer({
  services,
  plugins: [HotReload.use({ entry: 'src/services.ts', watch: ['src'] })],
})
```

`entry` exports the `services` array (or a default export); every save under `watch` becomes
one reload after a short debounce. On Bun the entry is bundled together with everything under
the watched paths into one fresh module — a change in ANY of those files reaches the node,
while imports resolving outside (`@ozaco/*`, node_modules) stay the instances the app already
runs. Other runtimes re-evaluate the entry alone. A broken save is reported and the last good
declarations keep serving; `HotReload.actions.reload()` / `.status()` do it by hand.

What a reload does NOT do: re-run plugin `start` hooks (a plugin refreshes derived state in its
`reload` hook instead), re-install the database or the transport, or migrate module-level
state — every module under the watched paths is a fresh instance after a reload.

## One codebase, three shapes

`role` decides what a node is; every node declares **every** service, so `ctx.call` stays typed
wherever the callee runs.

| role                 | hosts                                                      | edge                     | calls to services it does not host |
| -------------------- | ---------------------------------------------------------- | ------------------------ | ---------------------------------- |
| `monolith` (default) | all                                                        | yes                      | —                                  |
| `gateway`            | none                                                       | yes                      | forwarded over the carrier         |
| `service`            | `hosted` (default: `process.env.SERVICE`, comma-separated) | only if an edge is given | forwarded over the carrier         |

`start()` runs the plugins' start hooks, mounts `/_health`, listens, then waits for `dependsOn`
(gateway/monolith wait for every service they do not host; a `service` node waits for nobody).
`stop()` pauses the edge (`pauseMs`), leaves the cluster, drains in-flight work (`drainMs`),
unserves and tears the plugins down in reverse.

## Observe

Install an exporter (or `ObservePlugin`) and the node observes itself: every request is a trace
with a real root, every action a span named `{service}.{action}` under its own `service.name`, every
failure recorded ONCE — where it happened, with its whole cause chain — and every log line (std
Logger, `ctx.log`, `ctx.event`, `Server.actions.report`) a log record correlated to the span it was
written in. There is no knob for what to record: the kernel decides once and **every sink — the
store, stdout, OTLP, OpenObserve, your own — receives the identical spans and log records**.

```ts
import { createServer } from '@ozaco/server'
import { BunEdge } from '@ozaco/server/edge/bun'
import { OpenObserveExporter } from '@ozaco/server/plugins/observe/openobserve'
import { OtlpExporter } from '@ozaco/server/plugins/observe/otlp'
import { main, suspend } from '@ozaco/std/effect'
import { BunIO } from '@ozaco/std/io/impl/bun'
import { DefaultLogger, LogLevel } from '@ozaco/std/logger'
import { ConsoleTransport } from '@ozaco/std/logger/transport/console'
import { TraceTransport } from '@ozaco/std/logger/transport/trace'

await main(function* () {
  yield* BunIO.use()

  // the std Logger at the ROOT: every line — yours, the db's, the transport's — becomes a record
  yield* DefaultLogger.use({ level: LogLevel.info })
  yield* ConsoleTransport.use()
  yield* TraceTransport.use()

  const server = yield* createServer({
    name: 'shop', // `service.namespace` — give every node of the app the same one
    services: [todos],
    edge: BunEdge,
    listen: { port: 8080 },
    observe: { environment: 'production' },
    plugins: [
      OtlpExporter.use({ url: 'http://localhost:4318' }), // grafana/otel-lgtm, any OTLP collector
      OpenObserveExporter.use({
        url: 'http://localhost:5080',
        auth: { user: 'root@example.com', pass: process.env.OO_PASS ?? '' },
      }),
    ],
  })

  yield* server.start()
  yield* suspend()
})
```

A node observes when it has an exporter or an `observe` hook (`ObservePlugin`) of its own, or when
tracing is already on around it (a test's in-memory `Trace` sink). A node that does not observe
records nothing, but still forwards the trace context it would continue.

### What you get

| where                                     | what you see                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tempo / Grafana**                       | one trace per request rooted at the edge SERVER span (`POST /todos/:id`, `rootServiceName` = the node); dispatch spans under their ozaco service (`todos`); db spans (`insert todos`); CLIENT/SERVER pairs between nodes, PRODUCER/CONSUMER for events and jobs; span events (`exception`, `ws.send`, …) in the Events accordion — Grafana 13 has no exception box, and cuts event names past 20 characters, so ozaco's stay shorter; links under References; the service graph with client→server, messaging and database (`db.namespace`) edges |
| **Loki**                                  | every log record: `trace_id` / `span_id` as structured metadata, labels `service_name`, `service_namespace`, `service_instance_id`, `deployment_environment_name`; an exception record's line IS the cause chain; attribute keys with `.` → `_` (`exception_type`, `otel_event_name`). Loki drops the OTLP event name, which is why every event record also carries `otel.event.name`                                                                                                                                                             |
| **Prometheus** (through the collector)    | the metrics derived from the recorded spans: `http.server.request.duration`, `http.server.active_requests`, `rpc.server.call.duration`, `rpc.client.call.duration`, `ozaco.action.duration`, `messaging.process.duration`, `ozaco.ws.session.duration`, `ozaco.ws.messages`, `ozaco.service.up` — dots become `_` plus the unit suffix (`http_server_request_duration_seconds_bucket`, `ozaco_service_up_ratio`); Tempo adds `traces_service_graph_*` and `traces_spanmetrics_*`                                                                  |
| **OpenObserve**                           | the same spans under Traces (`span_status`, `error_type`, the `events` / `links` JSON columns, keys lowercased with `.` → `_`, resource keys prefixed `service_`), the same records under Logs (`o2_event_name` and `otel_event_name`, the chain in `body`), metric streams                                                                                                                                                                                                                                                                       |
| **`/_observe`** (`ObservePlugin` console) | root spans newest first; a waterfall indented by parent with a service badge per span, its events and log records inline, clickable links, the failure chain                                                                                                                                                                                                                                                                                                                                                                                      |
| **stdout** (`StdoutExporter`)             | one line per span (time, service, kind, name, duration, `ok` / `✗ type`, `trace_id=` / `span_id=` / `parent_id=`, attributes; events and links indented under it, an `exception` event's stacktrace as a block below it) and per log record (an exception with its chain indented)                                                                                                                                                                                                                                                                |

### Spans

| step                                                                   | kind                                    | name                                                                                                                      | carries                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP request (edge)                                                    | server                                  | `{METHOD} {route}` — `{METHOD}` unrouted, `HTTP` for an unknown method                                                    | `http.request.method`, `http.route`, `url.path`, `url.scheme`, `url.query` (secrets redacted), `server.address`, `server.port`, `client.address`, `user_agent.original`, `http.response.status_code`, `error.type`, `ozaco.request.id`; ends when the response BODY is done (a stream on its last chunk) |
| WS upgrade                                                             | server                                  | `GET {route}`                                                                                                             | the HTTP keys, `ozaco.ws.session.id` (what every frame of the session carries); ends at 101 or the refusal                                                                                                                                                                                               |
| WS inbound frame (not `auth` / `ping` / `pong`)                        | server, a ROOT per frame                | `WS {route}` — from receipt to the handler's next read                                                                    | `http.route`, `ozaco.ws.message.type`, `ozaco.ws.message.size`, `ozaco.ws.session.id`, link `ws.session`; sends are `ws.send` events on the active span; the close is one `socket closed` record                                                                                                         |
| action, in process                                                     | internal                                | `{service}.{action}`                                                                                                      | `code.function.name`                                                                                                                                                                                                                                                                                     |
| action over a carrier                                                  | client (caller) + server (owner)        | `{service}.{action}`                                                                                                      | `rpc.system.name = ozaco`, `rpc.method`, `rpc.response.status_code`; the caller's span lasts until a streamed reply is drained                                                                                                                                                                           |
| `emit` / its handler (`defineEvents.handle`, `Server.actions.process`) | producer / consumer                     | `publish {event}` / `process {event}`                                                                                     | `messaging.system = ozaco`, `messaging.operation.type`, `messaging.destination.name`, `messaging.message.id`; the consumer links its producer (`creation`); a `Server.actions.events()` reader's span gets an `event.recv` event per item and links the first 32 producers                               |
| `ctx.span` / `Server.actions.span`                                     | `kind` (default internal)               | yours                                                                                                                     | yours                                                                                                                                                                                                                                                                                                    |
| db operation (`@ozaco/db`) — only under a recording span               | client (memory adapter: internal)       | `{op} {table}`, `transaction`, `raw`; a Kv `{op} kv`                                                                      | `db.system.name`, `db.namespace`, `db.collection.name`, `db.operation.name`, `db.query.text` (parameterized SQL), `db.response.status_code`                                                                                                                                                              |
| queue enqueue / attempt (`@ozaco/db/queue`)                            | producer / consumer, a ROOT per attempt | `send {queue}` / `process {queue}`                                                                                        | `messaging.system = ozaco.queue`, `messaging.message.id` = the job id, `ozaco.queue.attempt`; links `creation` + `queue.retry`; `service.name` = the queue's `service` (default: its table)                                                                                                              |
| Cache lookup                                                           | internal                                | `cache {service}.{action}`                                                                                                | `ozaco.cache.{hit,coalesced,key,store,ttl_ms}`; a hit links the span that computed the value (`cache.producer`)                                                                                                                                                                                          |
| Cache invalidation from the change feed                                | internal ROOT, kept only on failure     | `cache.invalidate {table}`                                                                                                | link `change.writer`                                                                                                                                                                                                                                                                                     |
| Resilience                                                             | internal                                | `resilience.attempt` (attempts ≥ 2, a fallback's primary), `resilience.bulkhead.wait`                                     | `ozaco.resilience.{attempt,delay_ms}`                                                                                                                                                                                                                                                                    |
| `crud` op inside a custom action / realtime                            | internal                                | `crud.{op} {table}`; `watch {table}` (subscribe + first sync); a ROOT `crud.delta {table}` per push, kept only on failure | `ozaco.crud.scoped`; links `crud.watch`, `change.writer`; realtime: `service.name` = the service that declared the socket (a gateway serving it too)                                                                                                                                                     |
| HotReload generation                                                   | internal ROOT                           | `hot-reload` → `hot-reload.bundle`, `hot-reload.import`, `server.reload`                                                  | `ozaco.reload.{generation,triggers,services.added,services.removed,services.replaced}`; link `reload.previous`                                                                                                                                                                                           |
| std `Fetch` / `@ozaco/client` call                                     | client                                  | `{METHOD}` or `{METHOD} {template}` / `{METHOD} {route}`                                                                  | `http.request.method`, `url.full` (redacted), `url.template`, `server.address`, `server.port`, `http.response.status_code`; both inject `traceparent`                                                                                                                                                    |

Built-in `crud` actions open no span of their own — the dispatch span IS the op. Plugin-owned
routes and services (`/_health`, `Docs`, static files, the observe console) are recorded only when
they fail (`ObservePlugin.use({ selfTrace: true })` records the console's own traffic). A span has
at most 128 attributes, events and links; a string value is cut at 2048 UTF-8 bytes (Tempo's
limit).

### Failures

A failure is decided where it SETTLES, not where it is thrown: the causes a plugin or a wrapping
`fail(Tag, message, inner)` adds later, and the status the reply finally answers, are both known by
then. The chain lives in `causes` — a string is a domain cause, a Failure (a thrown value folded
into one, below) is the failure it wraps, nested as the same object, so a wrapped failure is
recorded as part of the one around it, never twice. It is then recorded exactly once per trace, on
the span it came from:

- ONE `exception` span event on the origin span: `exception.type`, `exception.message`,
  `exception.stacktrace` (the whole chain, under the span's generic 2048-byte value cap),
  `ozaco.failure.chain` (`type: message` of the failure, then of every failure nested in
  its causes, depth first) and `ozaco.failure.causes` (its own string causes; left out when it has
  none);
- ONE log record whose line is the whole chain, with the same attributes and an event
  name saying where it came from (below);
- `error.type` (the failure's tag) on every span it escaped, on both sides of a carrier;
- the same record handed to the std Logger when one is installed (the failure attached, bound
  `ozaco.telemetry='sent'` so `TraceTransport` does not emit it twice) — the console prints it.

```
stock.unavailable: cannot reserve
    at sku: x1
Caused by: stock.lookup: price lookup failed
Caused by: std:result.unknown: TypeError: sku x1 has no price
```

A level is `<type>: <message>`, its string causes as `at` lines, then each failure it wraps as a
`Caused by:` level (depth first, every level). No JavaScript stack frame is rendered anywhere.

A thrown value (an `Error`, or anything else that is not a Failure) is folded by `asFailure` into
ONE level: `std:result.unknown`, its `TypeError: x` text the message, the value itself kept as the
failure's `raw` — for the application to read; the server never does, and `raw` never crosses a
wire. The node answers it as `server.internal` (500) — that is its envelope tag (and a realtime
error frame's, the `message` of both the fold's `TypeError: x`) and its `error.type` — while
`exception.type` is the fold's tag (`std:result.unknown`) and `exception.message` its message, as
is a span's error status message. A library error whose own `code` says what happened is
classified by the plugin's tag matchers instead (`asFailure(error, AuthErrors)`: jose's
`ERR_JWT_EXPIRED` is `server:auth.expired-token`, a JWT that is not ours
`server:auth.invalid-token`; a bundler message HotReload got is `server:hot-reload.build`, at its
source position). Where the server rewraps a foreign throw (a body that is not JSON, a crashing
decorator or response body, jose's verdict in `JwtAuth`, a module HotReload cannot evaluate) it
nests that failure, one level under its own tag.

| answered with                                                                                            | spans it escaped                                            | record                                      |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------- |
| ≥ 500 (a throw, an unmapped tag)                                                                         | status error + `error.type`                                 | ERROR (17)                                  |
| < 500 (the action's `errors` map, validation, auth)                                                      | `error.type`, status unset — only a CLIENT span turns error | WARN (13)                                   |
| handled (retried, fallen back, recovered)                                                                | `error.type`, status unset — CLIENT spans included          | WARN (13)                                   |
| halted (a lost race, a stopped task)                                                                     | `ozaco.cancelled = true`, status unset                      | none — DEBUG (5) if the halt itself escaped |
| refused at the edge itself (404/405, a body that does not decode, 503 while stopping, a raw-route guard) | the edge span                                               | 5xx ERROR, else DEBUG (5)                   |

The HTTP edge span's status follows only its final response (5xx ⇒ error). The record's event name
tells the layer: `ozaco.action.exception` (in-process action), `rpc.server.call.exception` /
`rpc.client.call.exception` (carrier), `http.server.request.exception` (edge),
`http.client.request.exception` (std Fetch, `@ozaco/client`), `messaging.send.exception` /
`messaging.process.exception` (events, queue attempts), `db.client.operation.exception`, else
`exception`.

Across nodes the OWNER records it. The failure crosses the carrier whole — JsonCodec encodes every
nested failure (tag, message, causes; never a fold's `raw`) and decodes them back into real ones —
and the caller's decoder appends where it came from as a string cause, so the caller's rendering
shows `    at remote: stock.reserve @ stock span 1a2b3c4d` under it; the caller's spans get
`error.type` and `ozaco.failure.remote = true`, no second exception. The edge answers
`{ error: { error, message, causes, status, requestId, traceId } }` (plus the `oz-error` header),
readable by any client: `causes` holds the plain string causes — the ones the code appended, the
plugin runtime's location labels (`dispatch`, `<plugin>@<version>`, …) and the kernel's
`action:<service>.<action> span:<id> req:<id>` breadcrumbs, as they always did — but never the
`remote: …` ones a carrier hop added (the node that answered); those and the nested failures join
them (JsonCodec's
`{ _t: 'std:result:failure', error, message, causes }` — a thrown value itself never leaves the
node) only for callers `trace.trust` accepts, or for everyone with
`createServer({ errors: { expose: 'chain' } })`; `@ozaco/client` rebuilds them as Failures.

### Trace context

| inbound `traceparent`                                                   | the edge span                                                                                  |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `trace: { inbound: 'link' }` (default)                                  | a new root sampled here, LINKING the inbound context (`ozaco.link.reason = remote.parent`)     |
| `trace: { inbound: 'continue' }`                                        | continued, its sampled flag honoured                                                           |
| `trace: { inbound: 'ignore' }`                                          | a new root, no link                                                                            |
| a request `trace.trust(request)` returns `true` for                     | continued whatever `inbound` says, sampled flag honoured, the cause chain in its error replies |
| `tracestate` carrying `ozaco=1` (an observing ozaco client / std Fetch) | continued — one trace across ozaco nodes — but self-asserted: always recorded, no chain        |
| over a carrier                                                          | always continued, sampled flag honoured                                                        |

Every reply carries `x-request-id` and `traceresponse: 00-<trace id>-<span id>-<flags>`: the
edge span when the node traced the request (`trace: { response: false }` drops both; the sampled
bit is cleared on a `record: 'errors'` success — nothing of that trace is exported; an
`observe: 'off'` route sends none), else — a non-observing gateway — the span that ANSWERED
behind it, its own flags: the owner's dispatch span, carried back as the carrier reply's
`traceparent` (a success) or named by the failure's wire origin (a failure: the span that
recorded it — of a nested call when a hosted handler re-raised its failure), so an observing
caller still learns where its failure was recorded. The request id is a valid inbound `x-request-id`
(1–128 printable ASCII), else the trace id of a trace started here, else a fresh id; whenever it
differs from the trace id the edge span carries `ozaco.request.id`. WebSocket frames may carry
`traceparent` / `tracestate` fields (the server strips them before the handler). `Cors` allows
`traceparent` / `tracestate` and exposes `x-request-id` / `traceresponse` by default.

### Resource and capture

- `service.name`: with `observe: { serviceName: 'service' }` (default) a dispatch span names its
  ozaco service (`todos`) and its children inherit it; the edge span and records outside any
  dispatch use the node's name (`OTEL_SERVICE_NAME`, else `name`); a queue attempt, a root of its
  own, runs as the queue's `service` (`Queue.use({ table, service })`, default the table name).
  `'node'` uses the node's name everywhere; any other string is that name everywhere.
- `service.namespace` = `observe.namespace` ?? the app `name` — the key that ties every service of
  one app together (trace-to-logs below). Also `service.instance.id` (the node),
  `service.version`, `deployment.environment.name` (`observe.environment`), `telemetry.sdk.*`,
  `ozaco.carrier.name`, and `OTEL_RESOURCE_ATTRIBUTES` merged under them — in every sink.
- `observe: { capture: { headers, bodies, frames, enduser, sensitiveKeys } }` (all off;
  `ObservePlugin.use({ capture })` may turn keys on): `http.request.header.<name>` /
  `http.response.header.<name>` (authorization, cookies, API-key and token headers REDACTED),
  `http.{request,response}.body.content` (≤ 2 KiB) + `.size`, `ozaco.ws.message.body`,
  `enduser.id`. `url.query` / `url.full` always redact the values of the secret keys — one list,
  std:fetch `SENSITIVE_KEYS` (signature, token, key, password, secret, session, cookie, …) — and a
  captured header or body — a JSON request or response, a ws frame, multipart fields — gets the
  same list applied to its keys at every depth (`{"password":"REDACTED"}`, the access and refresh
  tokens of a login reply). `capture: { sensitiveKeys }` replaces the list
  (`[...SENSITIVE_KEYS, 'tenant']` adds to it); a `FetchClient.use({ sensitiveKeys })` does the
  same for its `url.full`. Captured bodies still reach every sink: gate the observe API
  (`ObservePlugin.use({ auth })`) when they are on.

### Log records

- `ctx.log.info('placing order', { sku })` — one record on the active span, scope
  `@ozaco/server`, forwarded to the std Logger (if any) without being emitted twice.
- A recorded exception (WARN and up) goes the same way: the record is emitted once, and the
  std Logger installed where it was recorded gets a line — the record's event name, `logger` = its
  scope, `trace=<8>` of the span that recorded it, the failure's own time (not when it settled),
  the failure attached — so the terminal shows what the telemetry recorded, chain included, the
  failure ONCE (a one-line one as `err=` on the line, a longer chain only as its indented block; a
  failure a Logger line carried is not printed a second time):

  ```
  [2026-09-27T02:10:07.794Z] ERROR logger="@ozaco/server" trace=35c41b64: ozaco.action.exception err="reports.boom: asked to fail"
  ```

- The std Logger through `TraceTransport`: severity TRACE 1 … FATAL 21 with the level's name, the
  `logger` binding as the instrumentation scope, bindings and data flattened into attributes
  (≤ 64, the rest one `ozaco.log.data` JSON; keys a backend reserves — `trace_id`, `body`,
  `severity`, … — move to `ozaco.data.<key>`). A failure logged at WARN+ inside a span is recorded
  through the same record-once rule. `createServer` installs a `TraceTransport` in its own scope
  when observing and none is visible; installed at the ROOT (above) it also bridges lines logged
  OUTSIDE the node — transport, db, your bootstrap — which the node claims
  (`observe: { processLogs }`, default on) with its resource.
- `ctx.event(name, attributes, { time })` — a span event plus a record with `eventName` and
  `otel.event.name`; `time` replays a client-side timeline.
- `Server.actions.report({ stream: 'audit', …fields })` — a record with event name `ozaco.local`,
  `ozaco.local.stream` and the fields flattened.
- Operational lines (transport reconnects, carrier presence, db bus gaps, queue lease expiry, cache
  invalidation failures, hot reloads, exporter delivery problems) go through the std Logger under
  `logger: '@ozaco/<package>/…'`; an exporter's own complaints never become telemetry.

Every record is budgeted ONCE before the fan-out — ≤ 96 attributes and ≤ 48 KiB, largest values
dropped first (`droppedAttributesCount`) — so every sink still holds the same record.

### Vocabulary

Keys are OTel semantic conventions where one exists, `ozaco.*` otherwise — one key per concept.

| area              | attributes                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| failures          | `error.type` (span), `exception.{type,message,stacktrace}`, `ozaco.failure.chain`, `ozaco.failure.causes` (event + record), `ozaco.failure.remote`, `ozaco.cancelled`                                        |
| requests / ws     | `ozaco.request.id`, `ozaco.ws.message.{type,size,body}`, `ozaco.ws.session.id`; the `socket closed` record: `ozaco.ws.messages.{received,sent}`, `ozaco.ws.session.duration`, `ozaco.ws.close.{code,reason}` |
| records           | `otel.event.name`, `ozaco.local.stream`, `ozaco.log.data`, `ozaco.data.<key>`                                                                                                                                |
| auth              | `ozaco.auth.outcome` (`granted` / `anonymous` / `denied`), `ozaco.auth.requirement`, `ozaco.auth.strategy`, `enduser.id` (capture)                                                                           |
| cors              | `ozaco.cors.preflight`, `ozaco.cors.allowed`, `ozaco.cors.reason`                                                                                                                                            |
| cache             | `ozaco.cache.{hit,coalesced,key,store,ttl_ms,tags}`                                                                                                                                                          |
| resilience        | `ozaco.resilience.{attempt,delay_ms,timeout_ms,rate_limit.remaining,singleflight,fallback,breaker.state,breaker.state.previous}`                                                                             |
| crud / hot reload | `ozaco.crud.{scoped,recovered,hook.phase}`, `ozaco.reload.*`                                                                                                                                                 |
| events / queue    | `ozaco.event.origin`, `messaging.destination.subscription.name`, `ozaco.queue.{attempt,kind,op}`, `ozaco.db.transaction.attempt`                                                                             |

Span events (all ≤ 20 characters): `exception`, `ws.send`, `ws.reject`,
`event.recv` (one per `Server.actions.events()` item on the reading span:
`messaging.destination.name`, `messaging.message.id` — the span also LINKS the item's `publish`
span, `creation`, for its first 32 items), `auth.skip` (an earlier strategy failed, a later
one answered),
`cors.reject`, `cache.evict`, `breaker` (also a record), `crud.hook`,
`db.tx.retry`, `queue.dead`.

| `ozaco.link.reason` | from → to                                                                  |
| ------------------- | -------------------------------------------------------------------------- |
| `remote.parent`     | an edge root → the inbound context it did not continue (`inbound: 'link'`) |
| `ws.session`        | a frame's root → its upgrade span                                          |
| `ws.reconnect`      | a redialled client's frame → the context its watch was opened with         |
| `creation`          | an event consumer / an `events()` reader / a queue attempt → its producer  |
| `queue.retry`       | a queue attempt → the previous attempt                                     |
| `cache.producer`    | a cache hit or coalesced wait → the span that computed the value           |
| `change.writer`     | a cache invalidation / crud push → the dispatch that wrote the change      |
| `crud.watch`        | a crud push → its watch span                                               |
| `breaker.trip`      | a fail-fast rejection → the span that opened the breaker                   |
| `singleflight`      | a follower → the leader it waited for                                      |
| `reload.previous`   | a hot-reload generation → the previous one                                 |

### Exporters

Options are **transport only** — where and how records travel, never what they contain.

| exporter                                                       | options                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OtlpExporter.use(…)`                                          | `url` (`/v1/{traces,logs,metrics}` appended), `headers`, `signalHeaders`, `encoding: 'protobuf'` (default) \| `'json'`, `gzip`, `timeoutMs` (default 10 s: ONE budget per batch delivery, retries included, and for the whole flush at stop), `retry` (`{ attempts: 5, initialMs: 1000, maxMs: 5000 }` or `false`), `batch` (`{ size: 200, waitMs: 1000, maxPending: 10 000 }`), `metrics` (`{ intervalMs: 10 000 }` or `false`), `fetch` |
| `OpenObserveExporter.use(…)`                                   | `url`, `org` (default `default`), `auth: { user, pass }` (basic) \| `{ token }` (bearer), `stream` (the `stream-name` of traces and logs, one or `{ traces, logs }`), and the OTLP options — the same pipeline against `/api/<org>/v1/*`. Keep protobuf: OpenObserve refuses a whole OTLP/JSON batch over one fractional number                                                                                                           |
| `StdoutExporter`                                               | none                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ObserveExporter.implement(…).build({ export, start, flush })` | your own destination: `export(event)` receives every `{ t: 'span', span, resource }` / `{ t: 'log', log, resource }`                                                                                                                                                                                                                                                                                                                      |

Delivery retries 429 / 502 / 503 / 504 and network errors (exponential backoff, `Retry-After`
honoured), never another status; once a destination stops answering, every signal gets a single
attempt until it answers again. `OtlpExporter.context` exposes `stats()` per signal (`sent`,
`dropped`, `failed`, `rejected` from `partialSuccess`, `retried`, `lastError`). Delivery problems
are Logger warnings, never telemetry. Metrics are derived from the recorded spans, in seconds, with
low-cardinality attribute allowlists (`http.server.request.duration` carries `error.type` only for
5xx).

### Store and console

`ObservePlugin.use({ console: true })` writes every record into `_ob2_spans` / `_ob2_logs`
(`observeTables`) through its own suppressed `DbClient` (`db: SqliteAdapter.use({ path })` keeps
it apart) — the same records the exporters get, nothing filtered. `retention` (spans and exception
records 7 days, other records 1 day), `batch`. The `Observe` actions: `traces(query)` (root spans
newest first: name, route, service, status, errorType, slowerThan, since, cursor), `trace(id)`
(spans + records), `request(id)` (a request id or a trace id), `watch`, `prune`, `stats`,
`cluster`; over HTTP under `/_observe/api/{traces,trace/:id,request/:id,stats,cluster,live}`.
The telemetry holds captured bodies and whole failure chains, so gate that API:
`auth` takes the action option's shapes (`['admin']`, a predicate over the principal, …; needs
`Auth`) — none given, it falls under `Auth`'s `default`, and `false` opens it even on a
fail-closed node. The `/_observe` page stays public: a shell holding no data that asks for a
bearer when the API refuses it. `cluster: { sendToCollector, isCollector, whenCollectorDown }` ships a
cluster's records to one collector node over the carrier (≤ 512 KiB per message).

### Grafana: logs for a whole trace

The stock `grafana/otel-lgtm` Tempo datasource maps only `service.name` and searches the clicked
span's time window — with a service name per ozaco service, the root span's "Logs for this span"
misses the downstream service's exception. Map `service.namespace` instead and search the whole
trace:

```yaml
# grafana/provisioning/datasources/tempo.yaml
apiVersion: 1
datasources:
  - name: Tempo
    type: tempo
    uid: tempo
    url: http://tempo:3200
    jsonData:
      tracesToLogsV2:
        datasourceUid: loki
        customQuery: true
        query: '{$${__tags}} | trace_id="$${__trace.traceId}"' # `$$` escapes `$` in provisioning
        tags:
          - key: service.namespace
            value: service_namespace
        spanStartTimeShift: '-1s'
        spanEndTimeShift: '1s'
      serviceMap:
        datasourceUid: prometheus
      nodeGraph:
        enabled: true
```

### Queries

`shop` is the app (`service.namespace`); Tempo, Loki and OpenObserve hold the same records.
TraceQL runs in Grafana's Tempo explore (or `GET /api/search?q=…`), LogQL in its Loki explore, and
OpenObserve's SQL on its Traces / Logs pages (stream `default`) or through
`POST /api/<org>/_search?type=traces|logs`.

**All failures** — every span a failure escaped (4xx and handled ones included), the 5xx ones, the
records:

```
TraceQL   { resource.service.namespace = "shop" && span.error.type != nil }
TraceQL   { resource.service.namespace = "shop" && kind = server && status = error }
LogQL     {service_namespace="shop"} | exception_type != ""
LogQL     {service_namespace="shop"} | severity_number >= 17
SQL traces  SELECT trace_id, operation_name, service_name, span_status, error_type FROM "default"
            WHERE service_service_namespace = 'shop' AND error_type IS NOT NULL
SQL logs    SELECT _timestamp, service_name, severity, body FROM "default"
            WHERE service_namespace = 'shop' AND exception_type IS NOT NULL
```

**A request by `x-request-id`** — a reply's `traceresponse` (and the error envelope's `traceId`)
names its trace; when the request id is not the trace id, the edge span carries it:

```
TraceQL   { span.ozaco.request.id = "req-42" }
LogQL     {service_namespace="shop"} | trace_id="<trace id>"
SQL traces  SELECT trace_id, operation_name FROM "default" WHERE ozaco_request_id = 'req-42'
SQL logs    SELECT * FROM "default" WHERE trace_id = '<trace id>' ORDER BY _timestamp
console   GET /_observe/api/request/req-42
```

**Exceptions with their chain** — the record's line is the chain; the span event keeps it as
`ozaco.failure.chain` (search any level, the root cause included):

```
TraceQL   { event:name = "exception" } | select(event.exception.message, event.ozaco.failure.chain)
TraceQL   { event.ozaco.failure.chain =~ ".*TypeError: .*" }
LogQL     {service_namespace="shop"} | otel_event_name="rpc.server.call.exception"
LogQL     {service_namespace="shop"} | ozaco_failure_chain=~".*TypeError.*"
SQL logs    SELECT _timestamp, service_name, otel_event_name, exception_type, body FROM "default"
            WHERE service_namespace = 'shop' AND exception_type IS NOT NULL ORDER BY _timestamp DESC
```

**Links** — which spans were started by what:

```
TraceQL   { resource.service.namespace = "shop" && link.ozaco.link.reason = "creation" }
TraceQL   { link.ozaco.link.reason = "remote.parent" }
SQL traces  SELECT trace_id, operation_name, links FROM "default"
            WHERE links LIKE '%"ozaco.link.reason":"creation"%'
```

**A queue job's attempts** — the enqueue and every attempt carry `messaging.message.id` = the job
id; each attempt is its own trace, linking the enqueue (`creation`) and the attempt before it
(`queue.retry`); a retried failure is a WARN record, a dead letter an ERROR one:

```
TraceQL   { span.messaging.message.id = "<job id>" } | select(span.ozaco.queue.attempt)
TraceQL   { resource.service.namespace = "shop" && link.ozaco.link.reason = "queue.retry" }
LogQL     {service_namespace="shop"} | otel_event_name="messaging.process.exception"
SQL traces  SELECT trace_id, operation_name, ozaco_queue_attempt, span_status, error_type FROM "default"
            WHERE messaging_message_id = '<job id>' ORDER BY start_time
```

Tempo finds a new trace by search only after ~15–30 s (by id at once); its `/api/v2/traces`
answer carries base64 ids, and search results drop a trace id's leading zeros.

`moon run server:test-observe` checks all of this against real backends: it starts
`grafana/otel-lgtm` and OpenObserve in docker (random ports, torn down afterwards) and runs
`tests/observe/*` against them — or against backends you already run, when `SERVER_TEST_OTLP_URL`
and the other `SERVER_TEST_*` urls are set. Without them the fast suite skips those tests.

### Underneath: `@ozaco/std/trace`

The server, `@ozaco/db`, `@ozaco/client`, `@ozaco/transport`, std `Fetch` and the std Logger all
instrument through one std module, so a library of your own can too:

```ts
import { Trace } from '@ozaco/std/trace'

function* charge(order: { id: string; total: number }) {
  return yield* Trace.actions.span(
    'payments.charge',
    { kind: 'client', attributes: { 'payments.order.id': order.id } },
    function* (handle) {
      handle.addEvent('payments.quote', { 'payments.total': order.total })
      return yield* callProvider(order)
    },
  )
}
```

- **Model.** Every feature is a `Trace.actions.*` call. `span(name, options?, body)` /
  `startSpan` (a `LiveSpan` you `run` and `end`, for streams) record `SpanData`; `event()`,
  `emitLog()` and `recordFailure()` emit `LogData`. Both go to every installed `Trace` impl (a
  cloneable protocol: `export(span)`, `emit(log)` — the server installs its own, a test an
  in-memory one). No impl, or tracing off in the scope, and a body runs with a no-op handle;
  `current()` answers the active span's handle (a no-op when none, `handle.valid === false`). A
  Result the body returns is unwrapped by the plugin runtime: `attempt` the call to get it back. The active span
  is a snapshot context holding the recorder, so every fork of a body writes to the same span.
- **Options.** `kind`, `attributes`, `links`, `service`, `scope`, `parent` (`null` starts a new
  trace), `requireParent` (no recording parent ⇒ no span — what `@ozaco/db` uses),
  `record: 'errors'` (a local root exported only when something in it failed) and
  `failure: { status, type, eventName }` classifiers (the outermost wins). A span opened without a
  `scope` takes its service's name (its own or inherited), else its local parent's scope unless
  that is an `@ozaco/…` library's, else `app` — your own spans are never labelled `@ozaco/std`
  (that scope is left to log records written outside any span).
- **Failures.** A failure escaping a span is HELD until it settles — a reply encoder calls
  `settle(f, { status })`, an ancestor handles it, or the local root ends — then recorded once per
  (failure, trace) at its origin span, as described [above](#failures). A failure nested in the
  causes of one around it is absorbed by it; one decoded from the wire that the sender recorded
  (`Trace.actions.markRecorded(f, traceId, { remote: true })`) only marks the span (`ozaco.failure.remote`). A
  handled failure sets `error.type` and never a status.
- **Time.** Every span and event reads one process-wide sub-millisecond clock, so a child never
  starts before its parent in the same process; a span's events reach every sink in time order.
- **Propagation.** `inject({ ozaco, context })` / `extract(getter | carrier)` follow W3C
  trace-context level 2 (`traceparent` + validated `tracestate`; an invalid header is ignored,
  never thrown on); `ozaco=1` in `tracestate` marks an exporting ozaco caller (`extract` sets
  `context.ozaco`); telemetry code runs `suppressed()` —
  no spans, no records, and the sampled flag cleared on anything it sends.
- **Logger bridge.** `TraceTransport` turns std Logger entries into `LogData` (above); the logger
  stamps every entry with the active span (`trace_id` / `span_id` in JSON lines, `trace=<8>` in
  pretty ones, where each failure prints once). A sink's `emit` runs with the record's own
  span active, so a Logger line it writes — the server's forwarded exceptions — carries that trace
  too. Records emitted where no scope traces — infrastructure outside any node — go to a
  process-level fallback (`Trace.actions.registerFallback`) that an observing server claims.

A `Trace` impl of your own — here an in-memory one for tests — turns tracing
on for the scope it is installed in:

```ts
import type { TraceDef } from '@ozaco/std/trace'
import { Trace } from '@ozaco/std/trace'

const spans: TraceDef.SpanData[] = []
const logs: TraceDef.LogData[] = []

export const MemoryTracer = Trace.implement({
  name: 'test/memory-tracer',
  version: '1.0.0',
  *setup() {
    yield* Trace.actions.enableTracing()
    return {}
  },
}).build({
  *export(span: TraceDef.SpanData) {
    spans.push(span)
  },
  *emit(log: TraceDef.LogData) {
    logs.push(log)
  },
})

// yield* MemoryTracer.use() — every span and record of the code below lands in `spans` / `logs`
```

## Subpaths

|                                                    |                                                                                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ozaco/server`                                    | everything above — the whole surface an application needs                                                                                      |
| `@ozaco/server/plugins`                            | `Auth`, `AuthStrategy`, `JwtAuth`, `StaticAuth`, `Cache`, `Cors`, `Docs`, `HotReload`, `ObservePlugin`, `StdoutExporter`, `Resilience`, `crud` |
| `@ozaco/server/edge/{bun,node,deno}`               | the HTTP/WS runtimes                                                                                                                           |
| `@ozaco/server/carrier/network`                    | `NetworkCarrier`, over `@ozaco/transport`                                                                                                      |
| `@ozaco/server/plugins/observe/{otlp,openobserve}` | the OTLP exporters: `OtlpExporter`, `OpenObserveExporter`, and the pipeline they share (`createOtlpPipeline`, `encodeSpans`, `encodeLogs`)     |
| `@ozaco/server/internal`                           | the kernel plumbing the first-party edges, carriers and plugins are built on — reach in only when writing one of your own                      |

A full worked example lives in [`examples/demo`](../../examples/demo).
