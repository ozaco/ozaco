import { defineConfig } from 'tsdown'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    resolve: './src/resolve.ts',
    vite: './src/vite.ts',
    bun: './src/bun.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  fixedExtension: false,
  clean: true,
  outDir: './dist',
  deps: {
    onlyBundle: [],
  },
  // `src/vite.ts` imports through the aliases (`client:codegen`, `std:*`): aliased to the
  // published packages and kept external (the config cannot import `src/resolve` — tsdown's
  // config loader does not resolve the repo's .ts modules)
  alias: {
    'client:codegen': '@ozaco/client/codegen',
    'std:effect': '@ozaco/std/effect',
    'std:result': '@ozaco/std/result',
  },
  external: [/^@ozaco\//u, 'unplugin'],
})
