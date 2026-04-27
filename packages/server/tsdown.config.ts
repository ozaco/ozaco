import { serverResolve, stdResolve } from '@ozaco/unplugin-resolve'
import { defineConfig } from 'tsdown'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    core: './src/core/index.ts',
    'plugin/router': './src/plugin/router/index.ts',
    'plugin/auth': './src/plugin/auth/index.ts',
    'plugin/cors': './src/plugin/cors/index.ts',
    'plugin/docs': './src/plugin/docs/index.ts',
    'transport/nats': './src/transport/nats/index.ts',
    'impl/bun': './src/impl/bun/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  fixedExtension: false,
  clean: true,
  outDir: './dist',
  deps: {
    onlyBundle: [],
  },
  plugins: [stdResolve.rolldown(), serverResolve.rolldown({ sourceDir: './src' })],
})
