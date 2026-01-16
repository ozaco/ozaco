import { createEvent } from 'std:event'
import { type BlobType, isArray } from 'std:shared'

import { PLUGIN } from '../const'
import type { Helpers, Impl } from '../types'

import { isDefinition } from './definition'

import { createApi } from './internal/api'
import { createRebind } from './internal/rebind'
import { createUse } from './internal/use'

export const createPlugin: Impl.CreatePlugin = (extendable, options, constructorDefinition) => {
  return (...args) => {
    type Result = Helpers.AnyPlugin

    const event = createEvent() as Result['event']
    const executedDefinitionMap = new WeakMap<Helpers.AnyDefinition, unknown>()
    const rebindings = new Set<string>()

    const rebind = createRebind({
      event,
      rebindings,
    })
    const api = createApi({
      executedDefinitionMap,
      extendable,
      rebind,
      event,
    })
    const use = createUse({
      executedDefinitionMap,
      extendable,
      rebind,
      event,
      api,
    })

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

          const targetVersion =
            (isArray(targetDependencies[key])
              ? (targetDependencies[key] as Helpers.AnyPlugin[]).at(-1)?.version
              : targetDependencies[key]?.version) ?? '*'

          if (
            dependencyVersion &&
            (dependencyVersion === '*' || targetVersion === '*' || dependencyVersion === targetVersion)
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
      const con = use(constructorDefinition)

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
