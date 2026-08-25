import { defineConfig } from 'tsdown'

import { stdResolve } from '../devkit/src/resolve'

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
    'io/impl/web': './src/io/impl/web.ts',
    fetch: './src/fetch/index.ts',
    ws: './src/ws/index.ts',
    webrtc: './src/webrtc/index.ts',
    codec: './src/codec/index.ts',
    'codec/impl/json': './src/codec/impl/json.ts',
    'codec/impl/toml': './src/codec/impl/toml.ts',
    'codec/impl/yaml': './src/codec/impl/yaml.ts',
    logger: './src/logger/index.ts',
    'logger/transport/console': './src/logger/transport/console/index.ts',
    'logger/transport/file': './src/logger/transport/file/index.ts',
    config: './src/config/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  fixedExtension: false,
  clean: true,
  outDir: './dist',
  plugins: [stdResolve.rolldown({ sourceDir: './src' })],
})
