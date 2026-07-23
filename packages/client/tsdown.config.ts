import { defineConfig } from 'tsdown'

import { stdResolve } from '../devkit/src/resolve'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    index: './src/index.ts',
    codegen: './src/codegen/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  fixedExtension: false,
  clean: true,
  outDir: './dist',
  plugins: [stdResolve.rolldown()],
})
