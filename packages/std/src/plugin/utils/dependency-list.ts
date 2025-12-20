import { DEPENDENCY_LIST } from '../const'
import type { Helpers, Impl } from '../types'

import { createContext } from './context'

export const createDependencyList: Impl.CreateDependencyList = defaultDependencies => {
  const dependencyMap = new Map<string, undefined>()

  const result = createContext(() => dependencyMap) as unknown as Helpers.AnyDependencyList

  result._t = DEPENDENCY_LIST

  result.add = dependencies => {
    for (const [fullName, version] of Object.entries(dependencies)) {
      const key = `${fullName}@${version}`

      if (dependencyMap.has(key)) {
        dependencyMap.set(key, undefined)
      }

      result.event.emit('add', [
        fullName,
        version as string,
      ])
    }

    return result
  }

  result.remove = dependencies => {
    for (const [targetFullName, targetVersion] of Object.entries(dependencies)) {
      if (targetVersion !== '*') {
        dependencyMap.delete(`${targetFullName}@${targetVersion}`)

        result.event.emit('remove', [
          targetFullName,
          targetVersion as string,
        ])
      } else {
        for (const key of dependencyMap.keys()) {
          const [fullName, version] = key.split('@')

          if (targetFullName === fullName) {
            dependencyMap.delete(key)

            result.event.emit('remove', [
              fullName,
              version as string,
            ])
          }
        }
      }
    }

    return result
  }

  result.add(defaultDependencies)

  return result
}

export const isDependencyList = (value: unknown): value is Helpers.AnyDependencyList => {
  return typeof value === 'object' && value !== null && '_t' in value && value._t === DEPENDENCY_LIST
}
