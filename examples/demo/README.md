# @ozaco/example-demo

One backend that exercises every `@ozaco/server` feature — a monolith, a gateway, or a service
node, all from one `createDemo(options)`. Each deployment shape is its own entrypoint, and
variations are consts at the top of that entrypoint; the only environment variables are where the
telemetry entrypoints ship (`scripts/targets.ts`: an address and credentials belong to the
deployment).

```bash
moon run demo:start            # monolith on :3000 → /docs (panel) · /_observe (observe, API gated) · /_health
moon run demo:dev              # the same, hot-reloading src/ on every save (HotReload)
moon run demo:cluster          # gateway :3000 + api-1 + api-2 in one process (memory link)
moon run demo:lgtm             # the cluster on :8080, shipping to Grafana's stack AND OpenObserve (prints where to look)
moon run demo:openobserve      # the cluster on :3000, shipping to OpenObserve
bun run scripts/client.ts      # the typed client walks every use case against :3000 (or a url)
bun run scripts/codegen.ts     # a standalone Api type from the manifest
bun test                       # monolith e2e + job queue + observe gate + terminal + cluster e2e + webrtc
```

`src/` follows the repo layout — `index.ts` (the public surface), `const.ts`, `errors.ts`,
`types/` (`demo` the public options and api, `helpers` the `Helpers` shapes `internal/` and
`utils/` pass around — no type is declared in those files), `utils/` (only the public `createDemo`,
`walk` and the tables), `internal/` (infrastructure, auth, the walk's own helpers, the rtc relay +
browser page, `services/`). Every runnable is an entrypoint under `scripts/`.

## Use-case map

| Feature                                                                                        | Where                                              |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| query / mutation / action kinds, routes, validation, custom errors                             | `internal/services/*.ts`                           |
| crud resource (`/todos`, If-Match conflicts) + realtime socket (`/todos/_realtime`)            | `internal/services/todos.ts`                       |
| ndjson / sse / text / bytes outputs, deadline + cancel                                         | `internal/services/feed.ts`                        |
| multipart `parts` input, raw byte body input, db-backed streaming download                     | `internal/services/media.ts`                       |
| cache (`cache`, tags, `invalidate`, table change invalidation)                                 | `internal/services/reports.ts`                     |
| retry / breaker / bulkhead / singleflight / rateLimit / timeout + fallback                     | `internal/services/reports.ts`                     |
| nested `ctx.call` (local or over the carrier)                                                  | `reports.overview`                                 |
| events (`ctx.emit`, `Server.actions.events`) relayed as SSE, custom socket route               | `internal/services/live.ts`                        |
| auth: login / refresh rotation / replay detection / `auth: 'user'` / roles                     | `internal/services/account.ts`, `internal/auth.ts` |
| auth strategies side by side (`JwtAuth` + `StaticAuth` under one `Auth`), service-level `auth` | `internal/services/jobs.ts`, `utils/demo.ts`       |
| reply shape: `status: 202` + static headers + per-call `ctx.reply({ headers })`                | `internal/services/jobs.ts`                        |
| rpc-style failures: a domain error mapped to **200** (`oz-error` header, client still fails)   | `internal/services/jobs.ts`, `errors.ts`           |
| durable job queue (`@ozaco/db/queue`): worker in a start hook, retries, dead letter            | `internal/services/jobs.ts`, `utils/tables.ts`     |
| `TableKv`: the kv as rows of the sqlite (cache, counters — persistent, cluster-shared)         | `internal/infrastructure.ts`                       |
| std `Logger` (`DefaultLogger` + `ConsoleTransport` + `TraceTransport`): lines = log records    | `internal/infrastructure.ts`                       |
| `column.blob()` for the upload chunks, `where.startsWith` prefix search                        | `utils/tables.ts`, `internal/services/media.ts`    |
| presence: members, who served a call                                                           | `internal/services/cluster.ts`                     |
| WebRTC call page (`/rtc`), signaling relay across nodes, peer metrics as span events           | `internal/services/rtc.ts`, `internal/rtc-page.ts` |
| app roles (monolith/gateway/service) via typed `DemoOptions`, one entrypoint per shape         | `utils/demo.ts`, `scripts/*.ts`                    |
| observe console behind `ObservePlugin.use({ auth })`, cluster forwarding, OTLP + OpenObserve   | `utils/demo.ts`, `scripts/lgtm.ts`                 |
| docs manifest + OpenAPI (`/docs/openapi.json`) + panel, cors, health, raw route                | `utils/demo.ts`                                    |
| typed client: calls, streams, uploads, realtime `$rows`, failures                              | `utils/walk.ts`                                    |

## Entrypoints

| entrypoint               | shape                                                                           |
| ------------------------ | ------------------------------------------------------------------------------- |
| `scripts/main.ts`        | one monolith on :3000                                                           |
| `scripts/cluster.ts`     | gateway :3000 + `api-1` + `api-2` on a memory link and one sqlite file          |
| `scripts/lgtm.ts`        | the same cluster, gateway on :8080, every node shipping OTLP + to OpenObserve   |
| `scripts/openobserve.ts` | the same cluster with every node shipping to OpenObserve (`OO_*`, `targets.ts`) |

The gateway waits for every service to show up in presence (`/_health` is 503 until then),
forwards calls over the carrier, and collects the other nodes' spans/logs into one observe store.
Infrastructure is fixed to the zero-dependency picks — memory transport, sqlite, and the kv as
rows of that sqlite (`TableKv`); a different stack is a new entrypoint installing its own
transport/adapter, not a flag.

### Telemetry in Grafana and OpenObserve

`moon run demo:lgtm` ships every node's spans, log records and metrics to a `grafana/otel-lgtm`
collector (`OTLP_URL`, default `http://localhost:4318`) and to OpenObserve (`OO_URL` /
`OO_ORG` / `OO_USER` / `OO_PASS`, default `http://localhost:5080`, `default`, `root@ozaco.dev` /
`Ozaco-pass1!` — OpenObserve refuses to boot without a strong root password). Both receive
exactly what the `/_observe` console holds. The gateway listens on :8080 because Grafana owns
:3000; once every node is up the script prints where to look — Grafana's queries, OpenObserve and
a ready `curl` against the console's API:

```bash
docker run -d --name oz-lgtm -p 3000:3000 -p 4318:4318 grafana/otel-lgtm
docker run -d --name oz-openobserve -p 5080:5080 -e ZO_ROOT_USER_EMAIL=root@ozaco.dev \
  -e ZO_ROOT_USER_PASSWORD='Ozaco-pass1!' public.ecr.aws/zinclabs/openobserve:latest
moon run demo:lgtm
bun run scripts/client.ts http://127.0.0.1:8080   # every use case once
```

Every node is its own `service.instance.id` (`gw`, `api-1`, `api-2`) under `service.namespace`
`demo`; spans inside a dispatch carry the ozaco service as `service.name` (`todos`, `jobs`, …),
and so do the queue's attempts (`Queue.use({ table, service: 'jobs' })`) and the worker's own
`render report` span (scope `demo/jobs`, the one its Logger line uses — a std `span()` without a
`scope` would take its service's name, never `@ozaco/std`). A reply's `traceresponse` header
names its trace; every recorded exception is also a std Logger line with `trace=<8>` of that
trace, so the terminal shows each failure once, with its chain. Things worth opening:

- Tempo (Grafana → Explore): `{ resource.service.namespace = "demo" }`; the queue:
  `{ span.messaging.message.id = "<job id>" }` finds every attempt of a job, each a root
  `process jobs` span linking the `send jobs` of its submit — a `fail` job's first two attempts
  are WARN (`error.type` only), the third is the dead letter (ERROR, `queue.dead`).
- Loki: `{service_namespace="demo"} | trace_id="<trace id>"` — the std Logger's lines and the
  exception records (their body is the whole `Caused by:` chain).
- OpenObserve: Traces / Logs in org `default`, same records.
- The gateway's `/_observe` console: its API (`/_observe/api/*`) answers admins and the ops bearer
  only (`ObservePlugin.use({ auth })`; the telemetry holds captured bodies and whole failure
  chains), the console asks for one:
  `curl -H 'authorization: Bearer demo-observe-token' 'http://127.0.0.1:8080/_observe/api/traces?limit=5'`.
- A WebRTC call (`/rtc#room`, two tabs): the `rtc.report` dispatch spans carry the peer counters
  as attributes and the client's timeline as `rtc.<kind>` span events at the client's own time.

### A call across two gateways

Each websocket is driven by the edge node that accepted it, so two tabs on two gateways are two
different nodes. The `rtc` relay keeps one room view per node and coordinates over the carrier's
event plane, so the pairing, the roles, the epoch and every signaling frame cross node boundaries.
Set `GATEWAYS = 2` in `scripts/cluster.ts`:

```bash
moon run demo:cluster
open http://127.0.0.1:3000/rtc#room   # tab 1 → gw-1
open http://127.0.0.1:3001/rtc#room   # tab 2 → gw-2
```

Seed users: `ada@example.com / ada` (admin), `bob@example.com / bob`. Service tokens (no login):
`Authorization: Bearer demo-mcp-token` — what `jobs.pending` (`auth: 'service'`) expects — and
`Authorization: Bearer demo-observe-token` (role `observe`) — what the observe API (and so the
console) expects besides an admin's JWT (`canObserve` in `internal/auth.ts`); anyone else gets 401 /
403 there.
