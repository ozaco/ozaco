import { extendableIO } from 'std:io'
import { createPlugin } from 'std:plugin'

import { stats } from './stats'

export const nodeIO = createPlugin(extendableIO.define(stats), {
  name: 'node',
})
