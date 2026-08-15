import { defineConfig } from 'tsdown'

import { cliResolve, stdResolve } from '../devkit/src/resolve'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    index: './src/core/index.ts',
    palette: './src/palette/index.ts',
    prompt: './src/prompt/index.ts',
    spinner: './src/spinner/index.ts',
    table: './src/table/index.ts',
    command: './src/command/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  fixedExtension: false,
  clean: true,
  outDir: './dist',
  deps: {
    onlyBundle: [],
    // zod is an optional peer, only ever loaded via a guarded dynamic import in cli:command
    neverBundle: ['bun', 'zod'],
  },
  // `cli:core` resolves to the external `@ozaco/cli` (dist/index.js), NOT inlined per bundle — so
  // the `Terminal`/`Palette`/… protocol singletons stay shared across the module bundles.
  plugins: [stdResolve.rolldown(), cliResolve.rolldown()],
})
