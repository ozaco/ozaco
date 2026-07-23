import {
  aiResolve,
  clientResolve,
  dbResolve,
  serverResolve,
  stdResolve,
} from '@ozaco/devkit/resolve'
import { defineConfig } from 'tsdown'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    'advanced/todo/server': './src/advanced/todo/server.ts',
    'basic/crud': './src/basic/crud/main.ts',
    'basic/custom-actions': './src/basic/custom-actions/main.ts',
    'basic/file-upload': './src/basic/file-upload/main.ts',
    'advanced/common': './src/advanced/common/main.ts',
    'basic/realtime': './src/basic/realtime/main.ts',
    'basic/interceptors': './src/basic/interceptors/main.ts',
    'basic/dataloaders': './src/basic/dataloaders/main.ts',
    'advanced/cluster/writer': './src/advanced/cluster/writer.ts',
    'advanced/cluster/watcher': './src/advanced/cluster/watcher.ts',
  },
  format: ['esm'],
  dts: false,
  fixedExtension: false,
  clean: true,
  outDir: './dist',
  plugins: [
    stdResolve.rolldown(),
    serverResolve.rolldown(),
    dbResolve.rolldown(),
    aiResolve.rolldown(),
    clientResolve.rolldown(),
  ],
})
