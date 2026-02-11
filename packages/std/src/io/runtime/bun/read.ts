import type { Impl } from 'std:io'
import { type FSError, IOErrors, Runtime, readDefinition } from 'std:io'
import { bunFileToNode } from 'std:io:node'
import { guard } from 'std:result'

import { readImplementation as nodeReadImplementation } from '../node/read'

export const readImplementation = readDefinition.extend(({ use }): Impl.Read<FSError | IOErrors.unsupported> => {
  const nodeReadApi = use(nodeReadImplementation)

  return guard(
    async function* (file, arrayBuffer, options) {
      return yield* await nodeReadApi(yield* await bunFileToNode(file), arrayBuffer, options)
    },
    IOErrors.read,
    Runtime.bun,
  )
})
