import { FSError, type Impl, IOErrors, open as openDefinition, Runtime } from 'std:io'
import { guard, throwable } from 'std:result'

import { stats as statsDefinition } from '../node/stats'

export const open = openDefinition.extend(({ use, def }): Impl.Open<FSError | IOErrors.unsupported> => {
  const statsApi = use(statsDefinition)

  return guard(
    async function* (handle) {
      const result = yield* await def(handle)

      result.stats = yield* await statsApi.stats(result.handle)
      result.raw = yield* throwable(() => Bun.file(result.handle.assembled), FSError)

      return result
    },
    IOErrors.open,
    Runtime.bun,
  )
})
