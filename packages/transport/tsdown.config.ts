import { defineConfig } from 'tsdown'

import { stdResolve, transportResolve } from '../devkit/src/resolve'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    index: './src/core/index.ts',
    'impl/memory': './src/impl/memory/index.ts',
    'impl/nats': './src/impl/nats/index.ts',
    'impl/redis': './src/impl/redis/index.ts',
    'impl/worker': './src/impl/worker/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  fixedExtension: false,
  clean: true,
  outDir: './dist',
  deps: {
    onlyBundle: [],
    // driver packages stay external so each impl module keeps a static, bundler-visible import
    neverBundle: ['@nats-io/nats-core', '@nats-io/transport-node', '@nats-io/jetstream', 'redis'],
  },
  // `transport:core` resolves to the external `@ozaco/transport` (dist/index.js), NOT inlined per
  // bundle — so the `Transport` protocol singleton stays shared across the impl modules.
  plugins: [stdResolve.rolldown(), transportResolve.rolldown()],
})
