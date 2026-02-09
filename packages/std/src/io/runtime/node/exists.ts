import { exists as existsDefinition, FSError, handle as handleDefinition, type Impl, IOErrors, Runtime } from 'std:io'
import { guard, isFailure } from 'std:result'

import { stats as nodeStatsDefinition } from './stats'

export const exists = existsDefinition.extend(({ use }): Impl.Exists<FSError | IOErrors.exists> => {
  const statsApi = use(nodeStatsDefinition)
  const handleApi = use(handleDefinition)

  return guard(
    async target => {
      const handle = handleApi(target)
      const result = await statsApi.stats(handle)

      if (isFailure(result)) {
        if (result.error instanceof FSError && result.error.code === 'ENOENT') {
          return false
        }
      }

      return true
    },
    IOErrors.exists,
    Runtime.node,
  )
})
