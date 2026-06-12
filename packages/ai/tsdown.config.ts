import { aiResolve, stdResolve } from '@ozaco/devkit/resolve'
import { defineConfig } from 'tsdown'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    index: './src/index.ts',
    openai: './src/impl/openai.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  fixedExtension: false,
  clean: true,
  outDir: './dist',
  deps: {
    onlyBundle: [],
  },
  plugins: [stdResolve.rolldown(), aiResolve.rolldown({ sourceDir: './src' })],
})
