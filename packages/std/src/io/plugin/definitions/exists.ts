import { createDefinition } from 'std:plugin'
import type { Impl } from '../../types'

export const existsDefinition = createDefinition((): Impl.Exists => {
  return {
    exists: async _target => {
      return false
    },

    existsSync: _target => {
      return false
    },
  }
}).key('exists')
