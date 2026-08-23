import { defineConfig } from 'tsdown'

import { dbResolve, serverResolve, stdResolve, transportResolve } from '../devkit/src/resolve'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  // entries are added as the modules land (edge/*, carrier/network, plugins, app)
  entry: {
    index: './src/core/index.ts',
    'edge/bun': './src/impl/edge/bun/index.ts',
    'edge/node': './src/impl/edge/node/index.ts',
    'edge/deno': './src/impl/edge/deno/index.ts',
    'carrier/network': './src/impl/carrier/network/index.ts',
    plugins: './src/plugins/index.ts',
    'plugins/observe/otlp': './src/plugins/observe/impl/otlp/index.ts',
    'plugins/metrics/starrocks': './src/plugins/metrics/impl/starrocks/index.ts',
    app: './src/app/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  fixedExtension: false,
  clean: true,
  outDir: './dist',
  deps: {
    onlyBundle: [],
    neverBundle: ['bun', 'ws', 'mysql2'],
  },
  // `server:core` resolves to the external `@ozaco/server` dist, NOT inlined per bundle — so the
  // protocol singletons stay shared across the impl/plugin modules
  plugins: [
    stdResolve.rolldown(),
    transportResolve.rolldown(),
    dbResolve.rolldown(),
    serverResolve.rolldown(),
  ],
})
