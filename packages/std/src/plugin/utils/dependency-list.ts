import { isArray, isString } from 'std:shared'

import { DEPENDENCY_LIST } from '../const'
import type { Helpers, Impl } from '../types'

import { createContext } from './context'
import { isPlugin } from './plugin'

export const createDependencyList: Impl.CreateDependencyList = (defaultDependencies, shared = false) => {
  const dependencyMap: Record<PropertyKey, Helpers.AnyPlugin | Helpers.AnyPlugin[]> = {}
  const dependencyVersionMap: Record<PropertyKey, string> = {}

  const result = createContext(() =>
    shared ? dependencyMap : Object.assign({}, dependencyMap),
  ) as unknown as Helpers.AnyDependencyList

  result._t = DEPENDENCY_LIST

  result.add = dependencies => {
    for (const [fullName, value] of Object.entries(dependencies)) {
      if (isPlugin(value)) {
        dependencyMap[fullName] = value
        dependencyVersionMap[fullName] = value.version
      } else if (isArray(value)) {
        if (!value.every(isPlugin)) {
          return result
        }

        const newList = isArray(dependencyMap[fullName]) ? dependencyMap[fullName] : []

        newList.push(...value)

        dependencyMap[fullName] = newList
        dependencyVersionMap[fullName] = value.at(-1)?.version ?? '*'
      } else if (isString(value)) {
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
        doesMatch = dependencyMap[fullName] === value
        targetVersion = value.version
      } else if (isString(value)) {
        doesMatch = dependencyVersionMap[fullName] === value
        targetVersion = value as string
      } else if (isArray(value) && value.every(isPlugin)) {
        doesMatch = false

        dependencyMap[fullName] = ((dependencyMap[fullName] as Helpers.AnyPlugin[]) ?? []).filter(current => {
          return !value.includes(current)
        })

        targetVersion = value.at(-1)?.version ?? '*'
      } else {
        return result
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

  result.getVersion = name => dependencyVersionMap[name]

  result.add(defaultDependencies)

  return result
}

export const isDependencyList = (value: unknown): value is Helpers.AnyDependencyList => {
  return typeof value === 'object' && value !== null && '_t' in value && value._t === DEPENDENCY_LIST
}
