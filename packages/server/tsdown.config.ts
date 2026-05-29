import { serverResolve, stdResolve } from '@ozaco/unplugin-resolve'
import { defineConfig } from 'tsdown'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    core: './src/core/index.ts',
    'transport/nats': './src/transport/nats/index.ts',
    'policy/bucket': './src/policy/bucket/index.ts',
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
