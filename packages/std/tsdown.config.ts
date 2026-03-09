import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    result: './src/result/index.ts',
    shared: './src/shared/index.ts',
    match: './src/match/index.ts',
  },
  dts: true,
  fixedExtension: false,
  clean: true,
  outDir: './dist',
})
