export const reverse =
  <T>() =>
  (input: Iterable<T>): T[] =>
    Array.from(input).toReversed()
