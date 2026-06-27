import { aiResolve, cliResolve, dbResolve, serverResolve, stdResolve } from '@ozaco/devkit/resolve'
import { defineConfig } from 'tsdown'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    app: './src/index.ts',
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
    cliResolve.rolldown(),
  ],
})
