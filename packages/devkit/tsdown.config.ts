import { defineConfig } from 'tsdown'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    resolve: './src/resolve.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  fixedExtension: false,
  clean: true,
  outDir: './dist',
  deps: {
    onlyBundle: [],
  },
})
