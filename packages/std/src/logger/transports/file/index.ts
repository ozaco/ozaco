import { extendableTransport } from 'std:logger:create-transport'

import { createPlugin } from 'std:plugin'
import { flush, init, trigger, write } from './definitions'

export const createFileTransport = createPlugin(
  extendableTransport.define(init, write, trigger, flush),
  {
    name: 'file',
    version: '1.0.0',
  },
  init,
)

export * from './types'
