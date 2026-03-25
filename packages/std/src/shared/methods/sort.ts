export const sort: {
  <T>(compareFn: (a: T, b: T) => number): (input: Iterable<T>) => T[]
  <T>(): (input: Iterable<T>) => T[]
} =
  <T>(compareFn?: (a: T, b: T) => number) =>
  (input: Iterable<T>): T[] =>
    Array.from(input).toSorted(compareFn)
