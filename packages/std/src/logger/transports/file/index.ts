import { extendableTransport } from 'std:logger:create-transport'

import { createPlugin } from 'std:plugin'
import { init, write } from './definitions'

export const createFileTransport = createPlugin(
  extendableTransport.define(init, write),
  {
    name: 'file',
    version: '1.0.0',
  },
  init,
)

export * from './types'
