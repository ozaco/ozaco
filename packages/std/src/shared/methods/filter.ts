export const filter: {
  <T, S extends T>(predicate: (value: T, index: number) => value is S): (input: Iterable<T>) => S[]
  <T>(predicate: (value: T, index: number) => boolean): (input: Iterable<T>) => T[]
} =
  <T>(predicate: (value: T, index: number) => boolean) =>
  (input: Iterable<T>): T[] => {
    const result: T[] = []
    let i = 0
    for (const v of input) {
      if (predicate(v, i++)) {
        result.push(v)
      }
    }
    return result
  }
