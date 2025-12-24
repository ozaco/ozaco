import { createExtendable } from 'std:plugin'

import { context } from './base'

import { colors } from './definitions/colors'
import { formatter } from './definitions/formatter'
import { getOptions, init } from './definitions/init'

export const extendable = createExtendable({
  namespace: 'std',
  name: 'color',
}).define(context, init.key('setOptions'), getOptions, formatter, colors)
