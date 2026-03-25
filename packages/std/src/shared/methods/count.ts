export const count: {
  <T>(predicate: (value: T, index: number) => boolean): (input: Iterable<T>) => number
  <T>(): (input: Iterable<T>) => number
} =
  <T>(predicate?: (value: T, index: number) => boolean) =>
  (input: Iterable<T>): number => {
    let n = 0
    let i = 0
    for (const v of input) {
      if (!predicate || predicate(v, i)) {
        n++
      }
      i++
    }
    return n
  }
