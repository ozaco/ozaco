import type { Operation } from 'std:effect'
import { all } from 'std:effect'

export function* map<T, U, E>(
  arr: readonly T[],
  mapFn: (value: T, index: number) => Operation<U, E>,
): Operation<U[], E> {
  const result: U[] = []
  for (let i = 0; i < arr.length; i++) {
    const mapped = yield* mapFn(arr[i]!, i)
    result.push(mapped)
  }
  return result
}

export function* mapPar<T, U>(
  arr: readonly T[],
  mapFn: (value: T, index: number) => Operation<U>,
): Operation<U[]> {
  return yield* all(arr.map((v, i) => mapFn(v, i)))
}

export function* some<T>(
  arr: readonly T[],
  predicate: (value: T, index: number) => Operation<boolean>,
): Operation<boolean> {
  for (let i = 0; i < arr.length; i++) {
    if (yield* predicate(arr[i]!, i)) {
      return true
    }
  }
  return false
}

export function* filter<T>(
  arr: readonly T[],
  predicate: (value: T, index: number) => Operation<boolean>,
): Operation<T[]> {
  const result: T[] = []
  for (let i = 0; i < arr.length; i++) {
    if (yield* predicate(arr[i]!, i)) {
      result.push(arr[i]!)
    }
  }
  return result
}

export function* filterPar<T>(
  arr: readonly T[],
  predicate: (value: T, index: number) => Operation<boolean>,
): Operation<T[]> {
  const results = yield* all(arr.map((v, i) => predicate(v, i)))
  return arr.filter((_, i) => results[i])
}

export function* toSorted<T>(
  arr: readonly T[],
  compareFn: (a: T, b: T) => Operation<number>,
): Operation<T[]> {
  const result = [...arr]

  for (let i = 1; i < result.length; i++) {
    const current = result[i]
    let j = i - 1

    while (j >= 0) {
      const cmp = yield* compareFn(result[j]!, current!)
      if (cmp <= 0) {
        break
      }

      result[j + 1] = result[j]!
      j--
    }

    result[j + 1] = current!
  }

  return result
}
