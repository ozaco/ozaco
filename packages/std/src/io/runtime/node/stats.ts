import { type BigIntStats as FsBigIntStats, type Stats as FsStats, statSync as fsStatsSync } from 'node:fs'
import { stat as fsStats } from 'node:fs/promises'

import { type Api, FSError, type Impl, IOErrors, PathType, Runtime, stats as statsDefinition } from 'std:io'
import { fail, guard, throwable } from 'std:result'
import type { BlobType } from 'std:shared'

export const stats = statsDefinition.extend(({ def }): Impl.Stats<IOErrors.unsupported | FSError> => {
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
  }

  return {
    stats: guard(
      async function* (handle, type: BlobType = 'bigint') {
        const result: Api.Stats<BlobType> = yield* await def.stats(handle, type)

        if (handle.type !== PathType.path && handle.type !== PathType.file) {
          return fail(IOErrors.unsupported, `(PathType) Expected: path got: ${handle.type}`)
        }

        const target = handle.type === PathType.file ? new URL(handle.assembled) : handle.assembled

        const current = yield* await throwable(
          () =>
            fsStats(target, {
              bigint: type === 'bigint',
            }),
          FSError,
        )

        createStats(result, current)

        return result
      },
      IOErrors.stats,
      Runtime.node,
    ),

    statsSync: guard(
      function* (handle, type: BlobType = 'bigint') {
        const result: Api.Stats<BlobType> = yield* def.statsSync(handle, type)

        if (handle.type !== PathType.path && handle.type !== PathType.file) {
          return fail(IOErrors.unsupported, `(PathType) Expected: path got: ${handle.type}`)
        }

        const target = handle.type === PathType.file ? new URL(handle.assembled) : handle.assembled

        const current = yield* throwable(
          () =>
            fsStatsSync(target, {
              bigint: type === 'bigint',
            }),
          FSError,
        )

        createStats(result, current)

        return result
      },
      IOErrors.statsSync,
      Runtime.node,
    ),
  }
})
