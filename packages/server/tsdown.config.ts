import { defineConfig } from 'tsdown'

import { dbResolve, serverResolve, stdResolve } from '../devkit/src/resolve'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    index: './src/core/index.ts',
    utils: './src/utils/index.ts',
    'gateway/bun': './src/gateway/bun/index.ts',
    'gateway/node': './src/gateway/node/index.ts',
    'gateway/deno': './src/gateway/deno/index.ts',
    'transport/worker': './src/transport/worker/index.ts',
    'transport/nats': './src/transport/nats/index.ts',
    'policy/cache': './src/policy/cache/index.ts',
    'policy/fallback': './src/policy/fallback/index.ts',
    'policy/bucket': './src/policy/bucket/index.ts',
    'policy/bulk': './src/policy/bulk/index.ts',
    'policy/rate-limit': './src/policy/rate-limit/index.ts',
    'policy/retry': './src/policy/retry/index.ts',
    'policy/circuit-breaker': './src/policy/circuit-breaker/index.ts',
    'policy/metrics': './src/policy/metrics/index.ts',
    'policy/timeout': './src/policy/timeout/index.ts',
    wizard: './src/wizard/index.ts',
    'plugin/metrics': './src/plugin/metrics/index.ts',
    'plugin/metrics/memory': './src/plugin/metrics/memory/index.ts',
    'plugin/metrics/starrocks': './src/plugin/metrics/starrocks/index.ts',
    'plugin/trace': './src/plugin/trace/index.ts',
    'plugin/trace/otlp': './src/plugin/trace/otlp/index.ts',
    'plugin/auth': './src/plugin/auth/index.ts',
    'plugin/docs': './src/plugin/docs/index.ts',
    daemon: './src/daemon/index.ts',
    'plugin/cors': './src/plugin/cors/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  fixedExtension: false,
  clean: true,
  outDir: './dist',
  deps: {
    onlyBundle: [],
    neverBundle: [
      'bun',
      'ws',
      '@nats-io/nats-core',
      '@nats-io/transport-node',
      '@nats-io/jetstream',
    ],
  },
  // `server:core`/`server:utils` resolve to the external `@ozaco/server` dist, NOT inlined per
  // bundle — the protocol singletons defined in core must stay shared across every module.
  plugins: [stdResolve.rolldown(), dbResolve.rolldown(), serverResolve.rolldown()],
})
