import type { BlobType } from 'std:shared'

import { PLUGIN } from '../const'
import type { Helpers, Impl } from '../types'

import { isContext } from './context'
import { isDefinition } from './definition'
import { isDependencyList } from './dependency-list'
import { isExtendable } from './extendable'

const createUse = (
  executedDefinitionMap: WeakMap<Helpers.AnyDefinition, unknown>,
  extendable: Helpers.AnyExtendable,
): Helpers.DefinitionUse => {
  return target => {
    if (isDependencyList(target) || isContext(target)) {
      return target.getBinding(extendable)
    } else if (isDefinition(target)) {
      const check = executedDefinitionMap.has(target)

      if (check) {
        return executedDefinitionMap.get(target)
      }

      return null
    } else if (isExtendable(target)) {
      const tempExecutedDefinitionMap = new WeakMap<Helpers.AnyDefinition, unknown>()

      return createApi(tempExecutedDefinitionMap, target)
    }

    return target
  }
}

const createApi = (
  executedDefinitionMap: WeakMap<Helpers.AnyDefinition, unknown>,
  extendable: Helpers.AnyExtendable,
) => {
  const api = {}
  const definitions = extendable.getDefinitions()

  const use = createUse(executedDefinitionMap, extendable)

  for (const definition of definitions) {
    const definitionValue = definition.getValue({
      use,
    })

    let result: unknown

    const key = definition.getKey()
    const required = definition.getRequired()

    if (required.length >= 0) {
      const missingKeys = required.filter(requiredKey => Reflect.has(definitionValue, requiredKey))

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

export const createPlugin: Impl.CreatePlugin = (extendable, options, constructorDefinition) => {
  return (...args) => {
    type Result = Helpers.AnyPlugin

    const executedDefinitionMap = new WeakMap<Helpers.AnyDefinition, unknown>()

    const use = createUse(executedDefinitionMap, extendable)
    const api = createApi(executedDefinitionMap, extendable)

    if (isDefinition(constructorDefinition)) {
      const con = constructorDefinition.getValue({
        use,
      })

      con(...args)
    }

    const result: Result = {
      _t: PLUGIN,
      _e: extendable,

      namespace: (options as BlobType).namespace ?? extendable._m.namespace,
      name: (options as BlobType).name ?? extendable._m.name,
      version: (options as BlobType).version ?? extendable._m.version,

      api,

      use: (list: Helpers.AnyDependencyList, dependencies) => {
        const dependencyMap = list.getBinding(extendable)

        if (!dependencyMap) {
          return result
        }

        const keys = dependencyMap.keys()

        for (const rawKey of keys) {
          const key = rawKey.toString()
          const [name, version] = key.split('@')

          const isAnyVersion = version === '*'

          if (!name || Reflect.has(dependencies, name)) {
            continue
          }

          if (isAnyVersion) {
            dependencyMap.set(rawKey, dependencies[name])
          } else if (dependencies[name] && version === dependencies[name].version) {
            dependencyMap.set(rawKey, dependencies[name])
          }
        }

        return result
      },

      unuse: (list: Helpers.AnyDependencyList, dependencies) => {
        const dependencyMap = list.getBinding(extendable)

        if (!dependencyMap) {
          return result
        }

        const keys = dependencyMap.keys()

        for (const rawKey of keys) {
          const key = rawKey.toString()
          const [name, version] = key.split('@')

          const isAnyVersion = version === '*'

          const isMatching = dependencies.some(
            dependency =>
              `${dependency.namespace}#${dependency.name}` === name &&
              (isAnyVersion ? true : dependency.version === version),
          )

          if (isMatching) {
            dependencyMap.delete(rawKey)
          }
        }

        return result
      },
    }

    return result
  }
}
