import { defineConfig } from 'tsdown'

import { dbResolve, stdResolve } from '../devkit/src/resolve'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    index: './src/index.ts',
    'impl-sqlite': './src/impl/sqlite/index.ts',
    'impl-postgres': './src/impl/postgres/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  fixedExtension: false,
  clean: true,
  outDir: './dist',
  deps: {
    onlyBundle: [],
  },
  plugins: [stdResolve.rolldown(), dbResolve.rolldown({ sourceDir: './src' })],
})
