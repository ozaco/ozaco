import { extendableIO } from 'std:io'
import { createPlugin } from 'std:plugin'

import { stats } from '../node/stats'

export const bunIO = createPlugin(extendableIO.define(stats), {
  name: 'bun',
})
