import { serverResolve, stdResolve } from '@ozaco/tsdown-plugin-resolve'
import { defineConfig } from 'tsdown'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    app: './src/index.ts',
  },
  format: ['esm'],
  dts: true,
  fixedExtension: false,
  clean: true,
  outDir: './dist',
  plugins: [stdResolve(), serverResolve()],
})
