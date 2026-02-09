import { exists as existsDefinition, FSError, handle as handleDefinition, type Impl } from 'std:io'
import { isFailure } from 'std:result'

import { stats as nodeStatsDefinition } from './stats'

export const exists = existsDefinition.extend(({ use }): Impl.Exists => {
  const statsApi = use(nodeStatsDefinition)
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

    existsSync: async target => {
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
