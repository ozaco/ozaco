import { type BigIntStats as FsBigIntStats, type Stats as FsStats, statSync as fsStatsSync } from 'node:fs'
import { stat as fsStats } from 'node:fs/promises'

import {
  type Api,
  FSError,
  type Impl,
  IOErrors,
  PathType,
  path as pathDefinition,
  Runtime,
  stats as statsDefinition,
} from 'std:io'
import { fail, guard, throwable } from 'std:result'
import type { BlobType } from 'std:shared'

export const stats = statsDefinition.extend(({ def, use }): Impl.Stats<IOErrors.unsupported | FSError> => {
  const path = use(pathDefinition)

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
    ...def,

    stats: guard(
      async function* (handler, type: BlobType = 'bigint') {
        const result: Api.Stats<BlobType> = yield* await def.stats(handler, type)

        if (handler.type !== PathType.path) {
          return fail(IOErrors.unsupported, `(PathType) Expected: path got: ${handler.type}`)
        }

        const current = yield* await throwable(
          () =>
            fsStats(path.join(handler.root ?? '', handler.dirname, handler.target), {
              bigint: type === 'bigint',
            }),
          FSError,
        )

        createStats(result, current)

        return result
      },
      IOErrors.stats,
      Runtime.bun,
    ),

    statsSync: guard(
      function* (handler, type: BlobType = 'bigint') {
        const result: Api.Stats<BlobType> = yield* def.statsSync(handler, type)

        if (handler.type !== PathType.path) {
          return fail(IOErrors.unsupported, `(PathType) Expected: path got: ${handler.type}`)
        }

        const current = yield* throwable(
          () =>
            fsStatsSync(path.join(handler.root ?? '', handler.dirname, handler.target), {
              bigint: type === 'bigint',
            }),
          FSError,
        )

        createStats(result, current)

        return result
      },
      IOErrors.statsSync,
      Runtime.bun,
    ),
  }
})
