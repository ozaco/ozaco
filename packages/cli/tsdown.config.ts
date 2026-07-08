import { defineConfig } from 'tsdown'

import { cliResolve, stdResolve } from '../devkit/src/resolve'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    core: './src/core/index.ts',
    palette: './src/palette/definition.ts',
    prompt: './src/prompt/definition.ts',
    spinner: './src/spinner/definition.ts',
    command: './src/command/definition.ts',
    table: './src/table/definition.ts',
    'terminal/bun': './src/terminal/bun.ts',
    // 'terminal/web': './src/terminal/web.ts',
    // 'terminal/memory': './src/terminal/memory.ts',
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
