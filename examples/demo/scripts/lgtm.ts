/**
 * `bun run scripts/lgtm.ts` (`moon run demo:lgtm`) — the cluster of `scripts/cluster.ts` (gateway
 * `gw` + `api-1` + `api-2`, each its own `service.instance.id`) with the gateway on :8080 —
 * Grafana owns :3000 — every node shipping its spans, log records and metrics over OTLP/HTTP to a
 * `grafana/otel-lgtm` collector (Tempo, Loki and Prometheus behind Grafana) AND to OpenObserve:
 * the same records in both, and in the `/_observe` console. Addresses and credentials come from
 * the environment (`scripts/targets.ts`); the defaults match these local containers:
 *
 *   docker run -d --name oz-lgtm -p 3000:3000 -p 4318:4318 grafana/otel-lgtm
 *   docker run -d --name oz-openobserve -p 5080:5080 \
 *     -e ZO_ROOT_USER_EMAIL=root@ozaco.dev -e ZO_ROOT_USER_PASSWORD='Ozaco-pass1!' \
 *     public.ecr.aws/zinclabs/openobserve:latest
 *
 * Then walk it (`bun run scripts/client.ts http://127.0.0.1:8080`) and look: Grafana → Explore
 * (Tempo `{ resource.service.namespace = "demo" }`, Loki `{service_namespace="demo"}`) at
 * http://localhost:3000, OpenObserve at http://localhost:5080, the gateway's own `/_observe`
 * console — its API sits behind `ObservePlugin.use({ auth })`: the ops bearer (`OBSERVE_TOKEN`)
 * or an admin's JWT, pasted when the console asks. A request's trace id is its `traceresponse`
 * header. Once the cluster is up, the script prints all of it.
 */
import { OBSERVE_TOKEN } from '../src'

import { runCluster } from './cluster'
import { openObserveTarget, otlpTarget } from './targets'

/** Grafana (and the otel-lgtm image) owns :3000. */
const PORT = 8080

/** Where to look, printed once every node is up. */
const howToLook = (url: string): string =>
  [
    '[lgtm] where the telemetry lands:',
    '  Grafana      http://localhost:3000 → Explore: Tempo { resource.service.namespace = "demo" } · Loki {service_namespace="demo"}',
    `  OpenObserve  ${openObserveTarget().url}`,
    `  /_observe    ${url}/_observe — its API answers admins and the ops bearer only; paste`,
    `               ${OBSERVE_TOKEN} when the console asks, or ask the API yourself:`,
    `    curl -H 'authorization: Bearer ${OBSERVE_TOKEN}' '${url}/_observe/api/traces?limit=5'`,
    `    an admin's JWT works too: POST ${url}/account/login {"email":"ada@example.com","password":"ada"} → accessToken`,
    `  traffic      bun run scripts/client.ts ${url}`,
  ].join('\n')

await runCluster(
  {
    otlp: otlpTarget(),
    openobserve: openObserveTarget(),
    // request/response bodies + WS frame bodies ride into the telemetry — every sink alike
    capture: true,
  },
  PORT,
  url => console.log(howToLook(url)),
)
