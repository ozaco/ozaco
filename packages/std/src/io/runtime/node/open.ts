import { closeSync as fsCloseSync } from 'node:fs'
import { type FileHandle as FSFileHanlde, open as fsOpenAsync } from 'node:fs/promises'

import { FSError, type Impl, IOErrors, open as openDefinition, Runtime } from 'std:io'
import { guard, throwable } from 'std:result'

import { stats as statsDefinition } from './stats'

export const open = openDefinition.extend(({ use, def }): Impl.Open<FSError | IOErrors.unsupported> => {
  const statsApi = use(statsDefinition)

  return guard(
    async function* (handle) {
      const result = yield* await def(handle)

      result.stats = yield* await statsApi.stats(handle)
      result.raw = yield* await throwable(() => fsOpenAsync(handle.assembled), FSError)

      result[Symbol.dispose] = () => {
        const file = result.raw as FSFileHanlde

        fsCloseSync(file.fd)
      }

      result[Symbol.asyncDispose] = async () => {
        const file = result.raw as FSFileHanlde

        await file.close()
      }

      return result
    },
    IOErrors.open,
    Runtime.node,
  )
})
