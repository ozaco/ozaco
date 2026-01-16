import type { BlobType } from 'std:shared'

import type { Impl } from '../../types'

import { createUse } from './use'

export const createApi: Impl.CreateApi = ({ event, extendable, executedDefinitionMap, rebind }) => {
  const api = {} as BlobType
  const definitions = extendable.getDefinitions()

  const use = createUse({
    rebind,
    executedDefinitionMap,
    extendable,
    event,
    api,
  })

  for (const definition of definitions) {
    const definitionValue = definition.getValue({
      use,
      event,
      rebind,
    })

    let result: unknown

    const key = definition.getKey()
    const required = definition.getRequired()

    if (required.length > 0) {
      const missingKeys = required.filter(requiredKey => !Reflect.has(definitionValue, requiredKey))

      if (missingKeys.length > 0) {
        throw new Error(`missingKeys in ${definition.getKey()}: ${missingKeys.join(',')}`)
      }
    }

    if (key) {
      result = {
        [key]: definitionValue,
      }
    } else {
      result = definitionValue
    }

    Object.assign(api, result)

    executedDefinitionMap.set(definition, definitionValue)
  }

  return api
}
