# @ozaco/example-demo

One backend that exercises every `@ozaco/server` feature — a monolith, a gateway, or a service
node, all from one `createDemo(options)`. No environment variables: each deployment shape is its
own entrypoint, and variations are consts at the top of that entrypoint.

```bash
moon run demo:start            # monolith on :3000 → /docs (panel) · /_observe (observe) · /_health
moon run demo:cluster          # gateway :3000 + api-1 + api-2 in one process (memory link)
moon run demo:openobserve      # the same cluster, shipping streams + traces to OpenObserve
bun run scripts/client.ts      # the typed client walks every use case against :3000
bun run scripts/codegen.ts     # a standalone Api type from the manifest
bun test                       # monolith e2e + cluster e2e + webrtc
```

`src/` follows the repo layout — `index.ts` (the public surface), `const.ts`, `errors.ts`,
`types/` (`demo` public, `internal` private), `utils/` (`createDemo`, `walk`, the tables),
`internal/` (infrastructure, auth, the rtc relay + browser page, `services/`). Every runnable
is an entrypoint under `scripts/`.

## Use-case map

| Feature                                                                                | Where                                              |
| -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| query / mutation / action kinds, routes, validation, custom errors                     | `internal/services/*.ts`                           |
| crud resource (`/todos`, If-Match conflicts) + realtime socket (`/todos/_realtime`)    | `internal/services/todos.ts`                       |
| ndjson / sse / text / bytes outputs, deadline + cancel                                 | `internal/services/feed.ts`                        |
| multipart `parts` input, raw byte body input, db-backed streaming download             | `internal/services/media.ts`                       |
| cache (`cache`, tags, `invalidate`, table change invalidation)                         | `internal/services/reports.ts`                     |
| retry / breaker / bulkhead / singleflight / rateLimit / timeout + fallback             | `internal/services/reports.ts`                     |
| nested `ctx.call` (local or over the carrier)                                          | `reports.overview`                                 |
| events (`ctx.emit`, `Server.actions.events`) relayed as SSE, custom socket route       | `internal/services/live.ts`                        |
| auth: login / refresh rotation / replay detection / `auth: 'user'` / roles             | `internal/services/account.ts`, `internal/auth.ts` |
| presence: members, who served a call                                                   | `internal/services/cluster.ts`                     |
| WebRTC call page (`/rtc`), signaling relay across nodes, peer metrics into observe     | `internal/services/rtc.ts`, `internal/rtc-page.ts` |
| app roles (monolith/gateway/service) via typed `DemoOptions`, one entrypoint per shape | `utils/demo.ts`, `scripts/*.ts`                    |
| observe console, cluster forwarding, OpenObserve export (streams + panels)             | `utils/demo.ts`, `scripts/openobserve.ts`          |
| docs manifest + OpenAPI (`/docs/openapi.json`) + panel, cors, health, raw route        | `utils/demo.ts`                                    |
| typed client: calls, streams, uploads, realtime `$rows`, failures                      | `utils/walk.ts`                                    |

## Entrypoints

| entrypoint               | shape                                                                      |
| ------------------------ | -------------------------------------------------------------------------- |
| `scripts/main.ts`        | one monolith on :3000                                                      |
| `scripts/cluster.ts`     | gateway :3000 + `api-1` + `api-2` on a memory link and one sqlite file     |
| `scripts/openobserve.ts` | the same cluster with every node shipping to OpenObserve (edit the consts) |

The gateway waits for every service to show up in presence (`/_health` is 503 until then),
forwards calls over the carrier, and collects the other nodes' spans/logs into one observe store.
Infrastructure is fixed to the zero-dependency picks — memory transport, sqlite, memory kv; a
different stack is a new entrypoint installing its own transport/adapter, not a flag.

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

Seed users: `ada@example.com / ada` (admin), `bob@example.com / bob`.
