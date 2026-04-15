import { stdResolve } from '@ozaco/tsdown-plugin-resolve'
import { defineConfig } from 'tsdown'

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  entry: {
    effect: './src/effect.ts',
    'say-hi': './src/say-hi.ts',
    plugin: './src/plugin/index.ts',
    'plugin-namespace': './src/plugin-namespace/index.ts',
  },
  dts: true,
  fixedExtension: false,
  clean: true,
  outDir: './dist',
  plugins: [stdResolve()],
})
