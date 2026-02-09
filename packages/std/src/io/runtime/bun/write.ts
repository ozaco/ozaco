import { open as fsOpenAsync } from 'node:fs/promises'

import type { Impl } from 'std:io'
import { FSError, IOErrors, Runtime, writeDefinition } from 'std:io'
import { guard, throwable } from 'std:result'

import { toFsFlag } from '../node/internal/utils'
import { writeImplementation as nodeWriteImplementation } from '../node/write'

export const writeImplementation = writeDefinition.extend(({ use }): Impl.Write<FSError | IOErrors.unsupported> => {
  const nodeWriteApi = use(nodeWriteImplementation)

  return guard(
    async function* (file, arrayBuffer, options) {
      if (file.meta.bun && !file.meta.node) {
        file.meta.node = yield* await throwable(() => fsOpenAsync(file.handle.assembled, toFsFlag(file.flag)), FSError)
      }

      return yield* await nodeWriteApi(file, arrayBuffer, options)
    },
    IOErrors.write,
    Runtime.bun,
  )
})
