# @ozaco/example-demo

One backend that exercises every `@ozaco/server` feature, shaped by the environment into a
monolith, a gateway, or a service node — plus a typed `@ozaco/client` walk-through and an
end-to-end test that runs the whole thing in-process.

```bash
moon run demo:start            # monolith on :3000 → /docs (panel) · /_observe (observe) · /_health
moon run demo:cluster          # gateway :3000 + api-1 + api-2 in one process (memory link)
                               # GATEWAYS=2 adds :3001 · TRANSPORT=nats uses a real carrier
bun run src/client.ts          # the typed client walks every use case against :3000
bun run scripts/codegen.ts     # a standalone Api type from the manifest
bun test                       # monolith e2e + cluster e2e
```

## Use-case map

| Feature                                                                                | Where                               |
| -------------------------------------------------------------------------------------- | ----------------------------------- |
| query / mutation / action kinds, routes, validation, custom errors                     | `services/*.ts`                     |
| crud resource (`/todos`, If-Match conflicts) + realtime socket (`/todos/_realtime`)    | `services/todos.ts`                 |
| ndjson / sse / text / bytes outputs, deadline + cancel                                 | `services/feed.ts`                  |
| multipart `parts` input, raw byte body input, db-backed streaming download             | `services/media.ts`                 |
| cache (`cache`, tags, `invalidate`, table change invalidation)                         | `services/reports.ts`, `media.list` |
| retry / breaker / bulkhead / singleflight / rateLimit / timeout + fallback             | `services/reports.ts`               |
| nested `ctx.call` (local or over the carrier)                                          | `reports.overview`                  |
| events (`ctx.emit`, `Server.actions.events`) relayed as SSE, custom socket route       | `services/live.ts`                  |
| auth: login / refresh rotation / replay detection / `auth: 'user'` / roles             | `services/account.ts`, `auth.ts`    |
| presence: members, who served a call                                                   | `services/cluster.ts`               |
| WebRTC call page (`/rtc`), signaling relay across nodes, peer metrics into observe     | `services/rtc.ts`, `rtc-page.ts`    |
| app roles, env-driven transport (memory/nats/redis), db (sqlite/pg), kv (memory/redis) | `app.ts`                            |
| observe console, forward/collect across nodes, OTLP traces/logs/metrics export         | `app.ts` (`OBSERVE`, `OTLP_URL`)    |
| docs manifest + OpenAPI (`/docs/openapi.json`) + panel, cors, health, raw route        | `app.ts`                            |
| typed client: calls, streams, uploads, realtime `$rows`, failures                      | `client.ts`                         |

## Cluster with real brokers

Start the broker yourself — the NATS transport speaks JetStream:

```bash
nats-server -js                # or: nats-server -js -sd /tmp/ozaco-nats
```

```bash
# terminal 1..3 — same code, different env
TRANSPORT=nats NATS_URL=nats://localhost:4222 DB=pg DATABASE_URL=postgres://… \
  ROLE=gateway INSTANCE=gw PORT=3000 OBSERVE=collect bun run src/main.ts
TRANSPORT=nats … SERVICE=account,todos,media INSTANCE=api-1 OBSERVE=forward bun run src/main.ts
TRANSPORT=nats … SERVICE=todo-stats,feed,reports,live,rtc,cluster INSTANCE=api-2 OBSERVE=forward bun run src/main.ts
```

The gateway waits for every service to show up in presence (`/_health` is 503 until then),
forwards calls over the carrier, and collects the other nodes' spans/logs into one observe store.

### A call across two gateways

Each websocket is driven by the edge node that accepted it, so two tabs on two gateways are two
different nodes. The `rtc` relay keeps one room view per node and coordinates over the carrier's
event plane, so the pairing, the roles, the epoch and every signaling frame cross node boundaries:

```bash
TRANSPORT=nats GATEWAYS=2 PORT=3000 bun run scripts/cluster.ts
open http://127.0.0.1:3000/rtc#oda   # tab 1 → gw-1
open http://127.0.0.1:3001/rtc#oda   # tab 2 → gw-2
```

Seed users: `ada@example.com / ada` (admin), `bob@example.com / bob`.
