import { stdResolve } from '@ozaco/tsdown-plugin-resolve'
import { defineConfig } from 'tsdown'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    result: './src/result/index.ts',
    shared: './src/shared/index.ts',
    effect: './src/effect/index.ts',
    event: './src/event/index.ts',
    plugin: './src/plugin/index.ts',
    io: './src/io/index.ts',
    'io-bun': './src/io/impl/bun.ts',
    'io-node': './src/io/impl/node.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  fixedExtension: false,
  clean: true,
  outDir: './dist',
  plugins: [stdResolve({ sourceDir: './src' })],
})
