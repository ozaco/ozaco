import { serverResolve, stdResolve } from '@ozaco/unplugin-resolve'
import { defineConfig } from 'tsdown'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    app: './src/index.ts',
    worker1: './src/worker1.ts',
    worker2: './src/worker2.ts',
  },
  format: ['esm'],
  dts: true,
  fixedExtension: false,
  clean: false,
  outDir: './dist',
  plugins: [stdResolve.rolldown(), serverResolve.rolldown()],
})
