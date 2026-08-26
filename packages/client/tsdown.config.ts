import { defineConfig } from 'tsdown'

import { clientResolve, serverResolve, stdResolve } from '../devkit/src/resolve'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    index: './src/core/index.ts',
    codegen: './src/codegen/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  fixedExtension: false,
  clean: true,
  outDir: './dist',
  deps: {
    onlyBundle: [],
  },
  // `client:core` resolves to the external `@ozaco/client` (dist/index.js), NOT inlined per
  // bundle — cross-entry imports stay shared instead of duplicating module state. `server:core`
  // stays external too: inlining would COPY the ServiceDef namespace (fresh phantom symbols)
  // and break the Action inference the typed inputs ride on.
  plugins: [stdResolve.rolldown(), serverResolve.rolldown(), clientResolve.rolldown()],
})
