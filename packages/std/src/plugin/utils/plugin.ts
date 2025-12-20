import type { BlobType } from 'std:shared'

import { PLUGIN } from '../const'
import type { Helpers, Impl } from '../types'

import { isContext } from './context'
import { isDefinition } from './definition'
import { isDependencyList } from './dependency-list'

export const createPlugin: Impl.CreatePlugin = (extendable, options, constructorDefinition) => {
  return (...args) => {
    type Result = Helpers.AnyPlugin

    const api = {}

    const use: Helpers.DefinitionUse = target => {
      if (isDependencyList(target) || isContext(target)) {
        return target.getBinding(extendable)
      }

      return target
    }

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
