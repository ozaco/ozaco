import { open as fsOpenAsync } from 'node:fs/promises'

import type { Impl } from 'std:io'
import { FSError, IOErrors, Runtime, read as readDefinition } from 'std:io'
import { guard, throwable } from 'std:result'
import { toFsFlag } from '../node/internal/utils'
import { read as nodeReadDefinition } from '../node/read'

export const read = readDefinition.extend(({ use }): Impl.Read<FSError | IOErrors.unsupported> => {
  const nodeReadApi = use(nodeReadDefinition)

  return guard(
    async function* (file, arrayBuffer, options) {
      if (file.meta.bun && !file.meta.node) {
        file.meta.node = yield* await throwable(() => fsOpenAsync(file.handle.assembled, toFsFlag(file.flag)), FSError)
      }

      return yield* await nodeReadApi(file, arrayBuffer, options)
    },
    IOErrors.read,
    Runtime.bun,
  )
})
