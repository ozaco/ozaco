export const flatMap =
  <T, U>(fn: (value: T, index: number) => U | readonly U[]) =>
  (input: Iterable<T>): U[] =>
    Array.from(input).flatMap((v, i) => fn(v, i))
