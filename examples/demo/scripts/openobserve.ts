/**
 * `bun run scripts/openobserve.ts` — the same cluster as `scripts/cluster.ts`, every node
 * shipping its spans, log records and metrics to OpenObserve's OTLP endpoints (the
 * Traces/Logs/Metrics panels) — exactly what the `/_observe` console holds. The deployment comes
 * from `OO_URL` / `OO_ORG` / `OO_USER` / `OO_PASS` (`scripts/targets.ts`; defaults: a local one,
 * `root@ozaco.dev` / `Ozaco-pass1!`):
 *
 *   docker run -d --name oz-openobserve -p 5080:5080 \
 *     -e ZO_ROOT_USER_EMAIL=root@ozaco.dev -e ZO_ROOT_USER_PASSWORD='Ozaco-pass1!' \
 *     public.ecr.aws/zinclabs/openobserve:latest
 *
 * OpenObserve refuses to boot without a strong root password (8+ characters, upper, lower, digit
 * and a symbol). `scripts/lgtm.ts` ships to Grafana's stack AND OpenObserve at once.
 */
import { runCluster } from './cluster'
import { openObserveTarget } from './targets'

await runCluster({
  openobserve: openObserveTarget(),
  // request/response bodies + WS frame bodies ride into the telemetry — every sink alike
  capture: true,
})
