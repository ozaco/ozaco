import type { AnyType } from '../types/common'

import { isObject } from './is'

/**
 * Recursively merge plain objects left → right; later sources win. Nested plain objects are merged
 * deeply, while arrays and primitives are REPLACED wholesale by the later value. An `undefined`
 * value never overrides an earlier one. Inputs are never mutated — a fresh tree is returned and
 * nested objects are cloned so the result never aliases a source (arrays are shared by reference).
 *
 * Typed honestly: the result is a full `T` only when the FIRST source is one; partials alone merge
 * into a `Partial<T>`.
 */
export function deepMerge<T extends Record<string, AnyType>>(
  base: T,
  ...sources: (Partial<T> | undefined)[]
): T
export function deepMerge<T extends Record<string, AnyType>>(
  ...sources: (Partial<T> | undefined)[]
): Partial<T>
export function deepMerge<T extends Record<string, AnyType>>(
  ...sources: (Partial<T> | undefined)[]
): Partial<T> {
  const result: Record<string, AnyType> = {}

  for (const source of sources) {
    if (!isObject(source)) {
      continue
    }

    for (const key of Object.keys(source)) {
      const next = source[key]
      if (next === undefined) {
        continue
      }

      const prev = result[key]
      result[key] = isObject(next) ? deepMerge(isObject(prev) ? prev : {}, next) : next
    }
  }

  return result as Partial<T>
}
