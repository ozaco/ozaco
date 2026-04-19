export const flat =
  <D extends number = 1>(depth?: D) =>
  <T>(input: Iterable<T>): FlatArray<T[], D>[] =>
    Array.from(input).flat(depth ?? (1 as D)) as FlatArray<T[], D>[]
