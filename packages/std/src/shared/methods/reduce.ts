export const reduce: {
  <T, U>(fn: (accumulator: U, value: T, index: number) => U, initial: U): (input: Iterable<T>) => U
  <T>(fn: (accumulator: T, value: T, index: number) => T): (input: Iterable<T>) => T
} =
  (fn: (accumulator: unknown, value: unknown, index: number) => unknown, ...args: [unknown] | []) =>
  (input: Iterable<unknown>): unknown => {
    let acc: unknown
    let i = 0
    let initialized = args.length > 0
    if (initialized) {
      acc = args[0]
    }
    for (const v of input) {
      if (!initialized) {
        acc = v
        initialized = true
        i++
        continue
      }
      acc = fn(acc, v, i++)
    }
    if (!initialized) {
      throw new TypeError('Reduce of empty iterable with no initial value')
    }
    return acc
  }
