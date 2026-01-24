import type { Api, Impl } from 'std:io'
import { Flags, type FSError, IOErrors, isHandle, Runtime, write as writeDefinition } from 'std:io'
import { guard } from 'std:result'
import { toFsFlag } from '../node/internal/utils'
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
        file = yield* await nodeOpenApi(rawFile, toFsFlag(Flags.write))
      } else {
        if (isBunFile(rawFile.raw)) {
          file = yield* await nodeOpenApi(rawFile.handle, toFsFlag(Flags.write))
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
