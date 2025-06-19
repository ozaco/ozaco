import { definePlugin } from 'clerc'
import type { Cli } from '../../src'
import { plugin as build } from './build/plugin'

export const plugin = definePlugin({
  setup: (cli: Cli) => cli.use(build),
})
