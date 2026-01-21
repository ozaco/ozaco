import { extendableIO } from 'std:io'
import { createPlugin } from 'std:plugin'

import { stats } from '../node/stats'
import { open } from './open'
import { read } from './read'
import { write } from './write'

export const createBunIO = createPlugin(extendableIO.clone().define(stats, open, read, write), {
  name: 'bun',
})

export const bunIO = createBunIO()

export const { api: io } = bunIO
