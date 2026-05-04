import type { Tags } from '../types/common'

import { kebabToPascal } from './string'

export const createTags = <const T extends string | null, const U extends string[]>(
  prefix: T,
  ...list: U
): Tags<T, U> => {
  const result = {} as Record<string, string>

  for (const value of list) {
    result[kebabToPascal(value)] = prefix ? `${prefix}.${value}` : value
  }

  return result as Tags<T, U>
}
