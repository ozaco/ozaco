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
import { column, DbClient, table, useDb } from '@ozaco/db'
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

const Todo = z.object({ title: z.string(), done: z.boolean() })

const todos = service('todos', {
  list: action.query({ output: z.array(Todo) }, function* () {
    return yield* (yield* useDb(todosTable)).query('todos').collect()
  }),

  add: action.mutation(
    { input: z.object({ title: z.string().min(1) }), output: Todo },
    function* ({ input }) {
      return yield* (yield* useDb(todosTable)).insert('todos', { title: input.title })
    },
  ),
})

await main(function* () {
  yield* BunIO.use()
  yield* MemoryAdapter.use()
  yield* DbClient.use({ tables: [todosTable] })

  const server = yield* createServer({ services: [todos], edge: BunEdge, listen: { port: 3000 } })
  const info = yield* server.start()

  console.log(`listening on ${info.url}`)
  yield* suspend()
})
```

`GET /todos/list` and `POST /todos/add` are live. `@ozaco/server/plugins`'s `Docs` adds
`/docs` (a try-it panel) and `/docs/openapi.json` from the same declarations.

## Defining

|                                                          |                                                                                                                                                |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `service(name, actions, options?)`                       | a named group of actions; routes default to `/<service>/<action>`                                                                              |
| `action.query` / `.mutation` / `.action` / `.stream`     | the kind fixes the default HTTP method (GET / POST / POST / GET), the manifest entry and how a client decodes it                               |
| `action.socket(config, handler)`                         | a WebSocket route declared inside the service                                                                                                  |
| `crud(table, options?)`                                  | a whole REST resource **as a service** — list/get/create/update/replace/remove plus a delta-watch socket. Goes straight into `services: [...]` |
| `serviceErrors(prefix, statuses)`                        | the failure taxonomy in one place: `errors: media.statuses` on the action, `yield* media.notFound(...)` in the handler                         |
| `stream.ndjson` / `.sse` / `.text` / `.bytes` / `.parts` | branded input/output planes; a stream handler may answer with an array, an async iterable, a `flowOf(...)` Flow or a branded stream            |

An action's config carries the plugin options as **typed fields** — `auth`, `cache`, `invalidate`,
`timeoutMs`, `retry`, `breaker`, `bulkhead`, `singleflight`, `rateLimit`, `fallback`. An unknown key
is a compile error, and a configuration failure at `createServer` if the owning plugin is not
installed.

## `ctx`

The one argument every handler gets, next to `input`:

| field                                      |                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| `requestId`, `spanId`, `trace`             | the ids this dispatch runs under                                               |
| `service`, `action`, `meta`                | what is running                                                                |
| `auth`                                     | the verified `Principal`, or `null`                                            |
| `log.debug/info/warn/error`                | structured lines bound to this request                                         |
| `signal`                                   | aborted when the caller leaves or the deadline passes                          |
| `headers`                                  | edge headers / socket handshake / carrier meta                                 |
| `call(service, 'action', input, options?)` | another action — local or over the carrier, typed from the definition          |
| `call(ref, input, options?)`               | the same, by ref (`server.api.todos.list`, `refs<typeof todos>('todos').list`) |
| `emit(name, payload)`                      | an event every node hears                                                      |
| `span(name, body, attrs?)`                 | a child span                                                                   |

The database and the cache are **not** mirrored on `ctx`: reach them where they live —
`yield* useDb(...tables)` (typed by your tables) and `Kv.actions`, both from `@ozaco/db`.

## Plugins

Installed in order through `createServer({ plugins })`; their dispatch hooks wrap in that order.

| plugin                                             | needs installed first                        | gives                                                                                |
| -------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Auth.use({ provider, secret \| keys, mode })`     | —                                            | the `auth` action option, `login` / `refresh` / `verify` / `signService`, `ctx.auth` |
| `Cache`                                            | a `Kv` (`MemoryKv` / `RedisKv`)              | the `cache` and `invalidate` options, table-change invalidation                      |
| `Resilience`                                       | —                                            | `timeoutMs`, `retry`, `breaker`, `bulkhead`, `singleflight`, `rateLimit`, `fallback` |
| `Cors.use({ origins })`                            | an edge                                      | CORS headers and preflight                                                           |
| `Docs.use({ path })`                               | an edge                                      | the manifest, OpenAPI 3.1 and the try-it panel                                       |
| `ObservePlugin.use({ console, forward, collect })` | a `DbClient` (a carrier for forward/collect) | requests/spans/logs/failures as db rows, `/_observe`                                 |
| `OtlpExporter` / `OpenObserveExporter`             | `ObservePlugin`                              | shipping those rows outward                                                          |

`NetworkCarrier` needs a transport (`MemoryTransport` / `NatsTransport` / `RedisTransport`)
installed before it.

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

## Subpaths

|                                                    |                                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `@ozaco/server`                                    | everything above — the whole surface an application needs                                                                 |
| `@ozaco/server/plugins`                            | `Auth`, `Cache`, `Cors`, `Docs`, `ObservePlugin`, `Resilience`, `crud`                                                    |
| `@ozaco/server/edge/{bun,node,deno}`               | the HTTP/WS runtimes                                                                                                      |
| `@ozaco/server/carrier/network`                    | `NetworkCarrier`, over `@ozaco/transport`                                                                                 |
| `@ozaco/server/plugins/observe/{otlp,openobserve}` | observe exporters                                                                                                         |
| `@ozaco/server/internal`                           | the kernel plumbing the first-party edges, carriers and plugins are built on — reach in only when writing one of your own |

A full worked example lives in [`examples/demo`](../../examples/demo).
