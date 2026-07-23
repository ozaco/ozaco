import { defineConfig } from 'tsdown'

import { dbResolve, stdResolve } from '../devkit/src/resolve'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    index: './src/core/index.ts',
    realtime: './src/realtime/index.ts',
    'impl/pg': './src/impl/pg.ts',
    'impl/bun': './src/impl/bun.ts',
    'impl/sqlite': './src/impl/sqlite.ts',
    'impl/surreal': './src/impl/surreal.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  fixedExtension: false,
  clean: true,
  outDir: './dist',
  deps: {
    onlyBundle: [],
    // driver packages stay external so each pool module keeps a static, bundler-visible import
    neverBundle: [
      'pg',
      'pg-query-stream',
      'pg-copy-streams',
      'surrealdb',
      '@surrealdb/node',
      'bun',
      'bun:sqlite',
    ],
  },
  // `db:core` resolves to the external `@ozaco/db` (dist/index.js), NOT inlined per bundle — so the
  // `DbDriver`/`Pool` protocol singletons stay shared across the impl/realtime modules.
  plugins: [stdResolve.rolldown(), dbResolve.rolldown()],
})
