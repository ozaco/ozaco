import { DEPENDENCY_LIST } from '../const'
import type { Helpers, Impl } from '../types'

import { createContext } from './context'
import { isPlugin } from './plugin'

export const createDependencyList: Impl.CreateDependencyList = defaultDependencies => {
  const dependencyMap: Record<string, Helpers.AnyPlugin> = {}
  const dependencyVersionMap: Record<string, string> = {}

  const result = createContext(() => dependencyMap) as unknown as Helpers.AnyDependencyList

  result._t = DEPENDENCY_LIST

  result.add = dependencies => {
    for (const [fullName, value] of Object.entries(dependencies)) {
      if (isPlugin(value)) {
        dependencyMap[fullName] = value
        dependencyVersionMap[fullName] = value.version
      } else {
        dependencyVersionMap[fullName] = value as string
      }

      result.event.emit('add', [
        fullName,
        dependencyVersionMap[fullName] as string,
      ])
    }

    return result
  }

  result.remove = (dependencies, force) => {
    for (const [fullName, value] of Object.entries(dependencies)) {
      let doesMatch = false
      let targetVersion: string

      if (isPlugin(value)) {
        doesMatch = dependencyMap[fullName] === value.version
        targetVersion = value.version
      } else {
        doesMatch = dependencyMap[fullName] === value
        targetVersion = value as string
      }

      if (doesMatch || force) {
        Reflect.deleteProperty(dependencyMap, fullName)
        Reflect.deleteProperty(dependencyVersionMap, fullName)
      }

      result.event.emit('remove', [
        fullName,
        targetVersion,
      ])
    }

    return result
  }

  result.add(defaultDependencies)

  return result
}

export const isDependencyList = (value: unknown): value is Helpers.AnyDependencyList => {
  return typeof value === 'object' && value !== null && '_t' in value && value._t === DEPENDENCY_LIST
}
