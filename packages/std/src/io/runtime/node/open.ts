import { closeSync as fsCloseSync } from 'node:fs'
import { type FileHandle as FSFileHandle, open as fsOpenAsync, writeFile as fsWriteFile } from 'node:fs/promises'

import { Flags, FSError, type Impl, IOErrors, open as openDefinition, Runtime } from 'std:io'
import { fail, guard, throwable } from 'std:result'

import { exists as existsDefinition } from './exists'
import { includePerm, toFsFlag } from './internal/utils'
import { stats as statsDefinition } from './stats'

export const open = openDefinition.extend(
  ({ use, def }): Impl.Open<FSError | IOErrors.missingFlag | IOErrors.unsupported> => {
    const statsApi = use(statsDefinition)
    const existsApi = use(existsDefinition)

    return guard(
      async function* (target, flag) {
        const result = yield* await def(target, flag)
        const exists = await existsApi.exists(result.handle)

        if (!exists) {
          if (!includePerm(result.flag, Flags.Moderator)) {
            return fail(IOErrors.missingFlag, 'Moderator flag is missing')
          }

          yield* await throwable(
            () =>
              fsWriteFile(result.handle.assembled, '', {
                flag: toFsFlag(result.flag),
              }),
            FSError,
            IOErrors.create,
          )
        }

        result.stats = yield* await statsApi.stats(result.handle)

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
