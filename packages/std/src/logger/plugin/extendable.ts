import { createExtendable } from 'std:plugin'

import { optionsContext } from './contexts'

import { conditional } from './definitions/conditional'
import { logDebug } from './definitions/debug'
import { init } from './definitions/init'
import { unstyled } from './definitions/unstyled'

export const partialExtendable = createExtendable({
  namespace: 'cli',
  name: 'logger',
}).define(
  optionsContext,

  init.key('setOptions'),

  unstyled.key('unstyled'),
  logDebug.key('debug'),
)

export const extendable = partialExtendable.define(conditional.key('if'))
