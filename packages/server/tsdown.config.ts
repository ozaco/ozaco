import { serverResolve, stdResolve } from '@ozaco/tsdown-plugin-resolve'
import { defineConfig } from 'tsdown'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    core: './src/core/index.ts',
    service: './src/service/index.ts',
    bun: './src/impl/bun.ts',
    'plugin/docs': './src/plugins/docs/index.ts',
    'plugin/auth': './src/plugins/auth/index.ts',
    'plugin/cors': './src/plugins/cors/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  fixedExtension: false,
  clean: true,
  outDir: './dist',
  deps: {
    onlyBundle: [],
  },
  plugins: [stdResolve(), serverResolve({ sourceDir: './src' })],
})
