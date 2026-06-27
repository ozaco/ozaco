import { defineConfig } from 'tsdown'

import { cliResolve, stdResolve } from '../devkit/src/resolve'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    core: './src/core/index.ts',
    // command: './src/command/index.ts',
    // prompt: './src/prompt/index.ts',
    // spinner: './src/spinner/index.ts',
    'impl/bun': './src/impl/bun.ts',
    // 'impl/web': './src/impl/web.ts',
    // 'impl/memory': './src/impl/memory.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  fixedExtension: false,
  clean: true,
  outDir: './dist',
  deps: {
    onlyBundle: [],
  },
  plugins: [stdResolve.rolldown(), cliResolve.rolldown({ sourceDir: './src' })],
})
