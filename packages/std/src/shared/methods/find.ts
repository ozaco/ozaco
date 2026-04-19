export const find: {
  <T, S extends T>(
    predicate: (value: T, index: number) => value is S,
  ): (input: Iterable<T>) => S | undefined
  <T>(predicate: (value: T, index: number) => boolean): (input: Iterable<T>) => T | undefined
} =
  <T>(predicate: (value: T, index: number) => boolean) =>
  (input: Iterable<T>): T | undefined => {
    let i = 0
    for (const v of input) {
      if (predicate(v, i++)) {
        return v
      }
    }
    return undefined
  }
