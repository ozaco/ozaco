import { Clerc } from 'clerc'

import pkg from '../package.json'

export const cli = Clerc.create()
  .name('ozaco')
  .scriptName('ozaco')
  .description(pkg.description)
  .version(pkg.version)
  .flag('cwd', 'Current Working Directory', {
    default: process.cwd(),
    type: String,
  })
  .flag('silent', 'Silent Mode', {
    alias: 's',
    default: false,
    type: Boolean,
  })

export type Cli = typeof cli

export * from 'clerc'
