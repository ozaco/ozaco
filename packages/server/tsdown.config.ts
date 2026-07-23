import { defineConfig } from 'tsdown'

import { dbResolve, serverResolve, stdResolve } from '../devkit/src/resolve'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    core: './src/core/index.ts',
    'transport/nats': './src/transport/nats/index.ts',
    'transport/worker': './src/transport/worker/index.ts',
    'policy/bucket': './src/policy/bucket/index.ts',
    'policy/retry': './src/policy/retry/index.ts',
    'policy/cache': './src/policy/cache/index.ts',
    'policy/circuit-breaker': './src/policy/circuit-breaker/index.ts',
    'policy/bulk': './src/policy/bulk/index.ts',
    'policy/timeout': './src/policy/timeout/index.ts',
    'policy/fallback': './src/policy/fallback/index.ts',
    'policy/metrics': './src/policy/metrics/index.ts',
    'gateway/bun': './src/gateway/bun/index.ts',
    'gateway/node': './src/gateway/node/index.ts',
    'plugin/cors': './src/plugin/cors/index.ts',
    'plugin/docs': './src/plugin/docs/index.ts',
    'plugin/auth': './src/plugin/auth/index.ts',
    daemon: './src/daemon/index.ts',
    wizard: './src/wizard/index.ts',
    metrics: './src/metrics/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  fixedExtension: false,
  clean: true,
  outDir: './dist',
  deps: {
    onlyBundle: [],
  },
  plugins: [
    stdResolve.rolldown(),
    serverResolve.rolldown({ sourceDir: './src' }),
    dbResolve.rolldown(),
  ],
})
