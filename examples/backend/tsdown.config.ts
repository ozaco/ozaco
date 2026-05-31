import { clientPlugin } from '@ozaco/unplugin-client'
import { dbResolve, serverResolve, stdResolve } from '@ozaco/unplugin-resolve'
import { defineConfig } from 'tsdown'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    app: './src/index.ts',
    services: './src/services.ts',
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
    clientPlugin.rolldown({
      entry: './src/services',
      clientModule: 'server:client',
    }),
  ],
})
