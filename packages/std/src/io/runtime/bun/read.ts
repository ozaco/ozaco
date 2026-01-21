import type { Api, Impl } from 'std:io'
import { type FSError, IOErrors, isHandle, Runtime, read as readDefinition } from 'std:io'
import { guard } from 'std:result'

import { open as nodeOpenDefinition } from '../node/open'
import { read as nodeReadDefinition } from '../node/read'
import { isBunFile } from '../utils/is'

export const read = readDefinition.extend(({ use }): Impl.Read<FSError | IOErrors.unsupported> => {
  const nodeOpenApi = use(nodeOpenDefinition)
  const nodeReadApi = use(nodeReadDefinition)

  return guard(
    async function* (rawFile, arrayBuffer, options) {
      let file: Api.File

      if (typeof rawFile === 'string' || isHandle(rawFile)) {
        file = yield* await nodeOpenApi(rawFile)
      } else {
        if (isBunFile(rawFile.raw)) {
          file = yield* await nodeOpenApi(rawFile.handle)
        } else {
          file = rawFile
        }
      }

      return yield* await nodeReadApi(file, arrayBuffer, options)
    },
    IOErrors.read,
    Runtime.bun,
  )
})
