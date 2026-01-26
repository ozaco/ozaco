import { writeFile as fsWriteFile } from 'node:fs/promises'

import { type Api, Flags, FSError, type Impl, IOErrors, open as openDefinition, Runtime } from 'std:io'
import { guard, isFailure, throwable } from 'std:result'

import { includePerm } from '../node/internal/utils'
import { stats as statsDefinition } from '../node/stats'

export const open = openDefinition.extend(({ use, def }): Impl.Open<FSError | IOErrors.unsupported> => {
  const statsApi = use(statsDefinition)

  return guard(
    async function* (handle, flag) {
      const result = yield* await def(handle, flag)

      const statsResult = await statsApi.stats(result.handle)

      let stats: Api.Stats

      if (
        includePerm(result.flag, Flags.create) &&
        isFailure(statsResult) &&
        statsResult.error instanceof FSError &&
        statsResult.error.code === 'ENOENT'
      ) {
        yield* await throwable(() => fsWriteFile(result.handle.assembled, ''), FSError, IOErrors.create)

        stats = yield* await statsApi.stats(result.handle)
      } else {
        stats = yield* statsResult
      }

      result.stats = stats
      result.raw = yield* throwable(() => Bun.file(result.handle.assembled), FSError)

      return result
    },
    IOErrors.open,
    Runtime.bun,
  )
})
