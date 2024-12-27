import { Clerc } from 'clerc'

import pkg from '../../package.json'

export const cli = Clerc.create()
  .name('ozaco')
  .scriptName('ozaco')
  .description(pkg.description)
  .version(pkg.version)
  .flag('cwd', 'current working directory', {
    default: process.cwd(),
    type: String,
  })

export type Cli = typeof cli
