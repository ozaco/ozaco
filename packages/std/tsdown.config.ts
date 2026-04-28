import { stdResolve } from '@ozaco/unplugin-resolve'
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
    'io/impl/bun': './src/io/impl/bun.ts',
    'io/impl/node': './src/io/impl/node.ts',
    fetch: './src/fetch/index.ts',
    logger: './src/logger/index.ts',
    'logger/transport/console': './src/logger/transport/console.ts',
    'logger/transport/file': './src/logger/transport/file.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  fixedExtension: false,
  clean: true,
  outDir: './dist',
  plugins: [stdResolve.rolldown({ sourceDir: './src' })],
})
