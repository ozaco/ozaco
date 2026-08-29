import type { AnyType } from '../types/common'
import type { Helpers } from '../types/helpers'

import { isObject } from './is'

const segments = (path: string): string[] => path.split('.').filter(Boolean)

/** Read a dotted key (`a.b.c`) from a nested object; `undefined` if any segment is missing. */
export const getPath = <T = unknown>(obj: Record<string, AnyType>, path: string): T | undefined => {
  let current: AnyType = obj

  for (const segment of segments(path)) {
    if (!isObject(current)) {
      return undefined
    }
    current = current[segment]
  }

  return current as T | undefined
}

/** Set a dotted key, returning a new object; intermediate objects are created/cloned as needed. */
export const setPath = <T extends Record<string, AnyType>>(
  obj: T,
  path: string,
  value: unknown,
): T => {
  const parts = segments(path)
  if (parts.length === 0) {
    return obj
  }

  const root: Record<string, AnyType> = { ...obj }
  let cursor = root

  for (const part of parts.slice(0, -1)) {
    const child = cursor[part]
    cursor[part] = isObject(child) ? { ...child } : {}
    cursor = cursor[part] as Record<string, AnyType>
  }

  cursor[parts.at(-1)!] = value
  return root as T
}

/** Remove a dotted key, returning a new object; a no-op (fresh copy) if the path is absent. */
export const unsetPath = <T extends Record<string, AnyType>>(obj: T, path: string): T => {
  const parts = segments(path)
  if (parts.length === 0) {
    return obj
  }

  const root: Record<string, AnyType> = { ...obj }
  let cursor = root

  for (const part of parts.slice(0, -1)) {
    const child = cursor[part]
    if (!isObject(child)) {
      return root as T
    }
    cursor[part] = { ...child }
    cursor = cursor[part] as Record<string, AnyType>
  }

  Reflect.deleteProperty(cursor, parts.at(-1)!)
  return root as T
}

/** Flatten a nested object to leaf `{ key, value }` entries; arrays are treated as leaf values. */
export const flattenEntries = (obj: Record<string, AnyType>, prefix = ''): Helpers.FlatEntry[] => {
  const entries: Helpers.FlatEntry[] = []

  for (const key of Object.keys(obj)) {
    const full = prefix ? `${prefix}.${key}` : key
    const value = obj[key]

    if (isObject(value)) {
      entries.push(...flattenEntries(value, full))
    } else {
      entries.push({ key: full, value })
    }
  }

  return entries
}
