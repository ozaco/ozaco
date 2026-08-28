import { defineConfig } from 'tsdown'

import { dbResolve, stdResolve, transportResolve } from '../devkit/src/resolve'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    index: './src/core/index.ts',
    'impl/memory': './src/impl/memory/index.ts',
    'impl/sqlite': './src/impl/sqlite/index.ts',
    'impl/pg': './src/impl/pg/index.ts',
    'impl/bun-sql': './src/impl/bun-sql/index.ts',
    'impl/memory-kv': './src/impl/memory-kv/index.ts',
    'impl/redis-kv': './src/impl/redis-kv/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  fixedExtension: false,
  clean: true,
  outDir: './dist',
  deps: {
    onlyBundle: [],
    // driver packages stay external so each adapter module keeps a static, bundler-visible import
    neverBundle: ['pg', 'bun', 'bun:sqlite', 'redis'],
  },
  // `db:core` resolves to the external `@ozaco/db` (dist/index.js), NOT inlined per bundle — so the
  // `DbAdapter`/`Db` protocol singletons stay shared across the impl modules.
  plugins: [stdResolve.rolldown(), transportResolve.rolldown(), dbResolve.rolldown()],
})
