import { type BlobType, isPromise } from 'std:shared'

import type { Impl } from '../types'

import { isFailure } from './is'
import { fail, succeed } from './result'

export const combine: Impl.Combine = (
  value: unknown,
  fn?: (value: unknown) => BlobType,
): BlobType => {
  const reduce = <T>(
    entries: Array<readonly [BlobType, BlobType]>,
    callback: (accumulator: T, value: unknown, entry: readonly [BlobType, BlobType]) => void,
    initialValue: T,
  ): BlobType => {
    const errors: unknown[] = []
    const results = entries.map(([, entry]) => (fn ? fn(entry) : entry))

    if (results.some(isPromise)) {
      return Promise.all(results).then((resolved): BlobType => {
        const accumulator = initialValue

        for (const [index, result] of resolved.entries()) {
          if (isFailure(result)) {
            errors.push(result.error)
          } else {
            callback(accumulator, result.value, entries[index]!)
          }
        }

        return errors.length > 0 ? fail(errors) : succeed(accumulator)
      }) as BlobType
    }

    const accumulator = initialValue

    for (const [index, result] of results.entries()) {
      if (isFailure(result)) {
        errors.push(result.error)
      } else {
        callback(accumulator, result.value, entries[index]!)
      }
    }

    return errors.length > 0 ? fail(errors) : succeed(accumulator)
  }

  if (Array.isArray(value)) {
    return reduce(
      [...value.entries()],
      (accumulator, item) => accumulator.push(item),
      [] as unknown[],
    )
  } else {
    return reduce(
      Object.entries(value as Record<string, BlobType>),
      (accumulator, item, [key]) => {
        accumulator[key] = item
      },
      {} as Record<string, unknown>,
    )
  }
}
