import { extendableIO } from 'std:io'
import { createPlugin } from 'std:plugin'

import { existsImplementation } from './exists'
import { openImplementation } from './open'
import { readImplementation } from './read'
import { statsImplementation } from './stats'
import { writeImplementation } from './write'

export const createNodeIO = createPlugin(
  extendableIO
    .clone()
    .define(statsImplementation, openImplementation, readImplementation, writeImplementation, existsImplementation),
  {
    name: 'node',
  },
)

export const nodeIO = createNodeIO()

export const { api: io } = nodeIO

export * from './utils'
