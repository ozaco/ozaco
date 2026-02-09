import { type BigIntStats as FsBigIntStats, type Stats as FsStats, statSync as fsStatsSync } from 'node:fs'
import { stat as fsStats } from 'node:fs/promises'

import {
  type Api,
  FSError,
  handle as handleDefinition,
  type Impl,
  IOErrors,
  PathType,
  Runtime,
  stats as statsDefinition,
} from 'std:io'
import { fail, guard, throwable } from 'std:result'
import type { BlobType } from 'std:shared'

export const stats = statsDefinition.extend(({ def, use }): Impl.Stats<IOErrors.unsupported | FSError> => {
  const handleApi = use(handleDefinition)

  const createStats = (result: Api.Stats<BlobType>, current: FsStats | FsBigIntStats) => {
    Object.defineProperties(result, {
      isFile: {
        value: current.isFile(),
        writable: false,
        configurable: true,
      },

      isDirectory: {
        value: current.isDirectory(),
        writable: false,
        configurable: true,
      },

      isSymlink: {
        value: current.isSymbolicLink(),
        writable: false,
        configurable: true,
      },

      isBlockDevice: {
        value: current.isBlockDevice(),
        writable: false,
        configurable: true,
      },

      isFifo: {
        value: current.isFIFO(),
        writable: false,
        configurable: true,
      },

      isSocket: {
        value: current.isSocket(),
        writable: false,
        configurable: true,
      },
    })

    result.size = current.size
    result.modification = +current.ctime > +current.mtime ? current.ctime : current.mtime
    result.access = current.atime

    result.device = current.dev
    result.mode = current.mode
    result.links = current.nlink

    result.blocks = current.blocks
    result.blockSize = current.blksize

    return result
  }

  return {
    stats: guard(
      async function* (target, type: BlobType = 'bigint') {
        const handle = handleApi(target)
        const result: Api.Stats<BlobType> = yield* await def.stats(handle, type)

        if (handle.type !== PathType.path && handle.type !== PathType.file) {
          return fail(IOErrors.unsupported, `(PathType) Expected: path got: ${handle.type}`)
        }

        const current = yield* await throwable(
          () =>
            fsStats(handle.assembled, {
              bigint: type === 'bigint',
            }),
          FSError,
        )

        return createStats(result, current)
      },
      IOErrors.stats,
      Runtime.node,
    ),

    statsSync: guard(
      function* (target, type: BlobType = 'bigint') {
        const handle = handleApi(target)
        const result: Api.Stats<BlobType> = yield* def.statsSync(handle, type)

        if (handle.type !== PathType.path && handle.type !== PathType.file) {
          return fail(IOErrors.unsupported, `(PathType) Expected: path got: ${handle.type}`)
        }

        const filePath = handle.type === PathType.file ? handle.assembled : new URL(handle.assembled)

        const current = yield* throwable(
          () =>
            fsStatsSync(filePath, {
              bigint: type === 'bigint',
            }),
          FSError,
        )

        return createStats(result, current)
      },
      IOErrors.statsSync,
      Runtime.node,
    ),
  }
})
