import type { Api, Impl } from 'std:io'
import { type FSError, FSFlags, IOErrors, isHandle, Runtime, write as writeDefinition } from 'std:io'
import { guard } from 'std:result'

import { open as nodeOpenDefinition } from '../node/open'
import { write as nodeWriteDefinition } from '../node/write'
import { isBunFile } from '../utils/is'

export const write = writeDefinition.extend(({ use }): Impl.Write<FSError | IOErrors.unsupported> => {
  const nodeOpenApi = use(nodeOpenDefinition)
  const nodeWriteApi = use(nodeWriteDefinition)

  return guard(
    async function* (rawFile, arrayBuffer, options) {
      let file: Api.File

      if (typeof rawFile === 'string' || isHandle(rawFile)) {
        file = yield* await nodeOpenApi(rawFile, FSFlags.write)
      } else {
        if (isBunFile(rawFile.raw)) {
          file = yield* await nodeOpenApi(rawFile.handle, FSFlags.write)
        } else {
          file = rawFile
        }
      }

      return yield* await nodeWriteApi(file, arrayBuffer, options)
    },
    IOErrors.write,
    Runtime.bun,
  )
})
