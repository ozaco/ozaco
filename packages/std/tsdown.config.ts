import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    result: './src/result/index.ts',
    shared: './src/shared/index.ts',
    event: './src/event/index.ts',
    plugin: './src/plugin/index.ts',
    'logger/index': './src/logger/index.ts',
    'logger/create-transport': './src/logger/create-transport/index.ts',
    'logger/transport-file': './src/logger/transports/file/index.ts',
    color: './src/color/index.ts',
    'io/index': './src/io/index.ts',
    'io/runtime-node': './src/io/runtime/node/index.ts',
    'io/runtime-bun': './src/io/runtime/bun/index.ts',
  },
  dts: true,
  fixedExtension: false,
  clean: true,
  outDir: './dist',
})
