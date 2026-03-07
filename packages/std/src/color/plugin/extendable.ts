import { createExtendable } from 'std:plugin'

import { context } from './base'

import { colorsImplementation } from './internal/colors'
import { formatterImplementation } from './internal/formatter'
import { getOptions, initImplementation } from './internal/init'

export const extendable = createExtendable({
  namespace: 'std',
  name: 'color',
}).define(
  context,
  initImplementation.key('setOptions'),
  getOptions,
  formatterImplementation,
  colorsImplementation,
)
