import type { Impl } from 'std:io'
import { type FSError, IOErrors, Runtime, writeDefinition } from 'std:io'
import { bunFileToNode } from 'std:io:node'
import { guard } from 'std:result'

import { writeImplementation as nodeWriteImplementation } from '../node/write'

export const writeImplementation = writeDefinition.extend(
  ({ use }): Impl.Write<FSError | IOErrors.unsupported> => {
    const nodeWriteApi = use(nodeWriteImplementation)

    return guard(
      async function* (file, arrayBuffer, options) {
        return yield* await nodeWriteApi(yield* await bunFileToNode(file), arrayBuffer, options)
      },
      IOErrors.write,
      Runtime.bun,
    )
  },
)
