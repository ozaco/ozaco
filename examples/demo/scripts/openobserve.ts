/**
 * `bun run scripts/openobserve.ts` — the same cluster as `scripts/cluster.ts`, every node
 * shipping to OpenObserve: the raw per-kind streams AND the Traces/Logs/Metrics panels, all
 * from the one exporter. Point the consts at your deployment
 * (`docker run -p 5080:5080 public.ecr.aws/zinclabs/openobserve:latest` for a local one).
 */
import { runCluster } from './cluster'

await runCluster({
  openobserve: {
    url: 'http://localhost:5080',
    // `user:pass` → HTTP basic, anything else → a bearer token
    auth: 'root@example.com:Complexpass#123',
    // request bodies + WS frame / emit payloads ride into the streams and traces
    bodies: true,
  },
})
