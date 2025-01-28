import { definePlugin } from 'clerc'

import { plugin as build } from './build/plugin'

import type { Cli } from '../../src'

export const plugin = definePlugin({
  setup: (cli: Cli) => cli.use(build),
})
