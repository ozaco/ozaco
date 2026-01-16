import { createExtendable, createPlugin } from 'std:plugin'

import { context, dependencies } from './base'

import { dir } from './definitions/dir'
import { getOptions, init } from './definitions/init.internal'
import { stats } from './definitions/stats'

export const extendable = createExtendable({
  namespace: 'std',
  name: 'io',
}).define(context, dependencies, getOptions, stats, dir)

export const createIO = createPlugin(
  extendable,
  {
    version: '0.0.0',
  },
  init,
)
