import { extendableIO } from 'std:io'
import { createPlugin } from 'std:plugin'

import { existsImplementation } from '../node/exists'
import { statsImplementation } from '../node/stats'
import { openImplementation } from './open'
import { readImplementation } from './read'
import { writeImplementation } from './write'

export const createBunIO = createPlugin(
  extendableIO
    .clone()
    .define(statsImplementation, openImplementation, readImplementation, writeImplementation, existsImplementation),
  {
    name: 'bun',
  },
)

export const bunIO = createBunIO()

export const { api: io } = bunIO
