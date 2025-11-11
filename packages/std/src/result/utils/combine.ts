/** biome-ignore-all lint/style/noNonNullAssertion: Redundant */

import { type BlobType, isPromise } from 'std:shared'

import type { Impl, Result, ResultMaybeAsync } from '../types'

import { isFailure } from './is'
import { fail, succeed } from './result'

export const combine: Impl.Combine = (
  value: unknown,
  fn?: (value: unknown) => ResultMaybeAsync<BlobType, BlobType>,
): BlobType => {
  const reduce = <T>(
    entries: Array<
      readonly [
        BlobType,
        BlobType,
      ]
    >,
    callback: (
      accumulator: T,
      value: unknown,
      entry: readonly [
        BlobType,
        BlobType,
      ],
    ) => void,
    initialValue: T,
  ): ResultMaybeAsync<T, unknown[]> => {
    const errors: unknown[] = []
    const results = entries.map(([, entry]) => (fn ? fn(entry) : entry) as ResultMaybeAsync<unknown, unknown>)

    if (results.some(isPromise)) {
      return Promise.all(results).then((results): ResultMaybeAsync<T, unknown[]> => {
        const accumulator = initialValue

        for (const [index, result] of results.entries()) {
          if (isFailure(result)) {
            errors.push(result.error)
          } else {
            callback(accumulator, result.value, entries[index]!)
          }
        }

        return errors.length > 0 ? fail(errors) : succeed(accumulator)
      })
    }

    const accumulator = initialValue

    for (const [index, result] of (results as Result<unknown, unknown>[]).entries()) {
      if (isFailure(result)) {
        errors.push(result.error)
      } else {
        callback(accumulator, result.value, entries[index]!)
      }
    }

    return errors.length > 0 ? fail(errors) : succeed(accumulator)
  }

  if (Array.isArray(value)) {
    if (fn) {
      return reduce(
        [
          ...value.entries(),
        ],
        (accumulator, value) => accumulator.push(value),
        [] as unknown[],
      )
    }

    return reduce(
      [
        ...(value as Array<ResultMaybeAsync<unknown, unknown>>).entries(),
      ],
      (accumulator, value) => accumulator.push(value),
      [] as unknown[],
    )
  } else {
    return reduce(
      Object.entries(value as Record<string, BlobType>),
      (accumulator, value, [key]) => {
        accumulator[key] = value
      },
      {} as Record<string, unknown>,
    )
  }
}
