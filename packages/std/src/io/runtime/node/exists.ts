import { fileURLToPath } from 'node:url'
import { exists as existsDefinition, FSError, handle as handleDefinition, type Impl, IOErrors, Runtime } from 'std:io'
import { guard, isFailure } from 'std:result'
import { isString } from 'std:shared'

import { stats as nodeStatsDefinition } from './stats'

export const exists = existsDefinition.extend(({ use }): Impl.Exists<FSError | IOErrors.exists> => {
  const statsApi = use(nodeStatsDefinition)
  const handleApi = use(handleDefinition)

  return guard(
    async path => {
      const resolvedHandle =
        path instanceof Buffer ? path.toString('utf8') : path instanceof URL ? fileURLToPath(path) : (path as string)
      const handle = isString(resolvedHandle) ? handleApi(resolvedHandle) : resolvedHandle
      const result = await statsApi.stats(handle)
      if (isFailure(result)) {
        if (result.error instanceof FSError && result.error.code === 'ENOENT') {
          return false
        }
      }
      return handle.assembled
    },
    IOErrors.exists,
    Runtime.node,
  )
})
