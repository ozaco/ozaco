import { defineConfig } from 'tsdown'

import { aiResolve, stdResolve } from '../devkit/src/resolve'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    index: './src/core/index.ts',
    'impl/openai': './src/impl/openai/index.ts',
    'impl/mock': './src/impl/mock/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  fixedExtension: false,
  clean: true,
  outDir: './dist',
  deps: {
    onlyBundle: [],
  },
  // `ai:core` resolves to the external `@ozaco/ai` (dist/index.js), NOT inlined per bundle — so
  // the `AiProvider`/`Ai` protocol singletons stay shared across the impl modules.
  plugins: [stdResolve.rolldown(), aiResolve.rolldown()],
})
