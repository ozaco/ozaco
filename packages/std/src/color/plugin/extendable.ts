import { createExtendable } from 'std:plugin'

import { optionsContext } from './context'

import { colors } from './definitions/colors'
import { formatter } from './definitions/formatter'
import { getOptions, init } from './definitions/init'

export const extendable = createExtendable({
  namespace: 'std',
  name: 'color',
}).define(optionsContext, init.key('setOptions'), getOptions, formatter, colors)
