import { extendableIO } from 'std:io'
import { createPlugin } from 'std:plugin'

import { stats } from '../node/stats'
import { open } from './open'

export const createBunIO = createPlugin(extendableIO.clone().define(stats, open), {
  name: 'bun',
})

export const bunIO = createBunIO()

export const { api: io } = bunIO
