import type { AnyType } from '../types/common'

import { isFunction, isObject } from './is'

export const flatten = (obj: Record<string, AnyType>, prefix = ''): Record<string, AnyType> => {
  const result: Record<string, AnyType> = {}
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    const val = obj[key]
    if (isFunction(val)) {
      result[fullKey] = val
    } else if (isObject(val)) {
      Object.assign(result, flatten(val as Record<string, AnyType>, fullKey))
    }
  }
  return result
}
