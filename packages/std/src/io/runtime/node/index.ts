import { extendableIO } from 'std:io'
import { createPlugin } from 'std:plugin'

import { open } from './open'
import { stats } from './stats'

export const nodeIO = createPlugin(extendableIO.clone().define(stats, open), {
  name: 'node',
})
