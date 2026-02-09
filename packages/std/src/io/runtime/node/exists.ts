import { existsDefinition, FSError, handleDefinition, type Impl } from 'std:io'
import { isFailure } from 'std:result'

import { statsImplementation } from './stats'

export const existsImplementation = existsDefinition.extend(({ use }): Impl.Exists => {
  const statsApi = use(statsImplementation)
  const handleApi = use(handleDefinition)

  return {
    exists: async target => {
      const handle = handleApi(target)
      const result = await statsApi.stats(handle)

      if (isFailure(result)) {
        if (result.error instanceof FSError && result.error.code === 'ENOENT') {
          return false
        }
      }

      return true
    },

    existsSync: target => {
      const handle = handleApi(target)
      const result = statsApi.statsSync(handle)

      if (isFailure(result)) {
        if (result.error instanceof FSError && result.error.code === 'ENOENT') {
          return false
        }
      }

      return true
    },
  }
})
