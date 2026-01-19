import { extendableIO } from 'std:io'
import { createPlugin } from 'std:plugin'

import { stats } from '../node/stats'
import { open } from './open'

export const bunIO = createPlugin(extendableIO.clone().define(stats, open), {
  name: 'bun',
})
