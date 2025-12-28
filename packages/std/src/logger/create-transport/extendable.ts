import { createExtendable } from 'std:plugin'

import { transportContext } from './base'

import { flush } from './definitions/flush'
import { init } from './definitions/init'
import { trigger } from './definitions/trigger'
import { write } from './definitions/write'

export const extendableTransport = createExtendable({
  namespace: 'cli/logger',
}).define(transportContext, init.key('setOptions'), write, flush, trigger)
