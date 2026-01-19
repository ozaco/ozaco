import { extendableIO } from 'std:io'
import { createPlugin } from 'std:plugin'

import { open } from './open'
import { stats } from './stats'

export const createNodeIO = createPlugin(extendableIO.clone().define(stats, open), {
  name: 'node',
})

export const nodeIO = createNodeIO()

export const { api: io } = nodeIO
