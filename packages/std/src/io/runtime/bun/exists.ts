import { exists as existsDefinition, type FSError, type Impl, IOErrors, Runtime } from 'std:io'
import { guard } from 'std:result'
import { exists as nodeExistsDefinition } from '../node/exists'

export const exists = existsDefinition.extend(({ use }): Impl.Exists<FSError | IOErrors.exists> => {
  const nodeExistsApi = use(nodeExistsDefinition)

  return guard(
    async function* (path) {
      return yield* await nodeExistsApi(path)
    },
    IOErrors.exists,
    Runtime.bun,
  )
})
