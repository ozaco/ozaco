import { createEvent } from 'std:event'
import { type BlobType, isArray } from 'std:shared'

import { PLUGIN } from '../const'
import type { Helpers, Impl } from '../types'

import { isContext } from './context'
import { isDefinition } from './definition'
import { isDependencyList } from './dependency-list'
import { isExtendable } from './extendable'

const createUse = (
  executedDefinitionMap: WeakMap<Helpers.AnyDefinition, unknown>,
  extendable: Helpers.AnyExtendable,
  event: Helpers.AnyPlugin['event'],
  currentApi?: BlobType,
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

      // FIX: this may be an illegal optimization !!!
      if (extendable === target) {
        return currentApi
      }

      return createApi(tempExecutedDefinitionMap, target, event)
    }

    return target
  }
}

const createApi = (
  executedDefinitionMap: WeakMap<Helpers.AnyDefinition, unknown>,
  extendable: Helpers.AnyExtendable,
  event: Helpers.AnyPlugin['event'],
) => {
  const api = {}
  const definitions = extendable.getDefinitions()

  const use = createUse(executedDefinitionMap, extendable, event, api)

  for (const definition of definitions) {
    const definitionValue = definition.getValue({
      use,
      event,
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

export const createPlugin: Impl.CreatePlugin = (extendable, options, constructorDefinition) => {
  return (...args) => {
    type Result = Helpers.AnyPlugin

    const event = createEvent() as Result['event']
    const executedDefinitionMap = new WeakMap<Helpers.AnyDefinition, unknown>()

    const api = createApi(executedDefinitionMap, extendable, event)
    const use = createUse(executedDefinitionMap, extendable, event, api)

    const result: Result = {
      _t: PLUGIN,
      _e: extendable,

      namespace: (options as BlobType).namespace ?? extendable._m.namespace,
      name: (options as BlobType).name ?? extendable._m.name,
      version: (options as BlobType).version ?? extendable._m.version,

      api,
      event,

      get: use,

      // TODO: version matching

      use: (list: Helpers.AnyDependencyList, targetDependencies) => {
        const dependencyMap = list.getBinding(extendable)

        if (!dependencyMap) {
          return result
        }

        const keys = Object.keys(dependencyMap)

        for (const key of keys) {
          const dependencyVersion = list.getVersion(key)

          if (
            dependencyVersion &&
            (dependencyVersion === '*' || dependencyVersion === targetDependencies[key]?.version)
          ) {
            if (isArray(dependencyMap[key])) {
              if (isArray(targetDependencies[key])) {
                dependencyMap[key].push(...targetDependencies[key])
              } else {
                dependencyMap[key].push(targetDependencies[key])
              }
            } else {
              dependencyMap[key] = targetDependencies[key]
            }

            event.emit('use', {
              plugin: result,
              dependencyList: list,
              dependency: dependencyMap[key],
            })
          }
        }

        return result
      },

      unuse: (list: Helpers.AnyDependencyList, targetDependencies) => {
        const dependencyMap = list.getBinding(extendable)

        if (!dependencyMap) {
          return result
        }

        const keys = Object.keys(dependencyMap)

        for (const key of keys) {
          const dependencyVersion = list.getVersion(key)

          if (
            dependencyVersion &&
            (dependencyVersion === '*' || dependencyVersion === targetDependencies[key]?.version)
          ) {
            event.emit('unuse', {
              plugin: result,
              dependencyList: list,
              dependency: dependencyMap[key],
            })

            if (isArray(dependencyMap[key])) {
              dependencyMap[key] = dependencyMap[key].filter(current => {
                return current !== targetDependencies[key]
              })
            } else {
              Reflect.deleteProperty(dependencyMap, key)
            }
          }
        }

        return result
      },
    }

    // Publish plugin event

    if (isDefinition(constructorDefinition)) {
      const con = constructorDefinition.getValue({
        use,
        event,
      })

      constructorDefinition.event.emit('plugin', result)

      con(...args)
    }

    for (const definition of extendable.getDefinitions()) {
      definition.event.emit('plugin', result)
    }

    return result
  }
}

export const isPlugin = (value: unknown): value is Helpers.AnyPlugin => {
  return typeof value === 'object' && value !== null && '_t' in value && value._t === PLUGIN
}
