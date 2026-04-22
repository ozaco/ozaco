import { dbResolve, stdResolve } from '@ozaco/unplugin-resolve'
import { defineConfig } from 'tsdown'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    index: './src/index.ts',
    core: './src/core.ts',
    schema: './src/schema/index.ts',
    query: './src/query.ts',
    'impl-sqlite': './src/impl/sqlite.ts',
    'impl-postgres': './src/impl/postgres.ts',
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
