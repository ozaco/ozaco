import { extendableIO } from 'std:io'
import { createPlugin } from 'std:plugin'

import { open } from './open'
import { read } from './read'
import { stats } from './stats'

export const createNodeIO = createPlugin(extendableIO.clone().define(stats, open, read), {
  name: 'node',
})

export const nodeIO = createNodeIO()

export const { api: io } = nodeIO
