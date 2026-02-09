import { closeSync as fsCloseSync } from 'node:fs'
import { type FileHandle as FSFileHandle, open as fsOpenAsync, writeFile as fsWriteFile } from 'node:fs/promises'

import { type Api, Flags, FSError, type Impl, IOErrors, open as openDefinition, Runtime } from 'std:io'
import { fail, guard, isFailure, throwable } from 'std:result'

import { includePerm, toFsFlag } from './internal/utils'
import { stats as statsDefinition } from './stats'

export const open = openDefinition.extend(
  ({ use, def }): Impl.Open<FSError | IOErrors.missingFlag | IOErrors.unsupported> => {
    const statsApi = use(statsDefinition)

    return guard(
      async function* (handle, flag) {
        const result = yield* await def(handle, flag)

        const statsResult = await statsApi.stats(result.handle)

        let stats: Api.Stats

        if (isFailure(statsResult) && statsResult.error instanceof FSError && statsResult.error.code === 'ENOENT') {
          if (!includePerm(result.flag, Flags.Moderator)) {
            return fail(IOErrors.missingFlag, 'Moderator flag is missing')
          }

          yield* await throwable(
            () =>
              fsWriteFile(result.handle.assembled, '', {
                flag: result.flag,
              }),
            FSError,
            IOErrors.create,
          )

          stats = yield* await statsApi.stats(result.handle)
        } else {
          stats = yield* statsResult
        }

        result.stats = stats

        result.meta.node = yield* await throwable(
          () => fsOpenAsync(result.handle.assembled, toFsFlag(result.flag | (flag ?? Flags.none))),
          FSError,
        )

        result[Symbol.dispose] = () => {
          const file = result.meta.node as FSFileHandle

          fsCloseSync(file.fd)
        }

        result[Symbol.asyncDispose] = async () => {
          const file = result.meta.node as FSFileHandle

          await file.close()
        }

        return result
      },
      IOErrors.open,
      Runtime.node,
    )
  },
)
