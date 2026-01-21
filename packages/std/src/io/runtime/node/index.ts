import { extendableIO } from 'std:io'
import { createPlugin } from 'std:plugin'

import { open } from './open'
import { read } from './read'
import { stats } from './stats'
import { write } from './write'

export const createNodeIO = createPlugin(extendableIO.clone().define(stats, open, read, write), {
  name: 'node',
})

export const nodeIO = createNodeIO()

export const { api: io } = nodeIO
