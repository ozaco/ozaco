import { clientPlugin } from '@ozaco/devkit/client'
import { aiResolve, dbResolve, serverResolve, stdResolve } from '@ozaco/devkit/resolve'
import { defineConfig } from 'tsdown'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    app: './src/index.ts',
    'worker/main': './src/worker/main.ts',
    'worker/entry': './src/worker/entry.ts',
  },
  format: ['esm'],
  dts: true,
  fixedExtension: false,
  clean: false,
  outDir: './dist',
  plugins: [
    stdResolve.rolldown(),
    serverResolve.rolldown(),
    dbResolve.rolldown(),
    aiResolve.rolldown(),
    clientPlugin.rolldown({
      entry: './src/utils/services',
    }),
  ],
})
