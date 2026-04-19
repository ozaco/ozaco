export const join =
  (separator?: string) =>
  <T>(input: Iterable<T>): string =>
    Array.from(input).join(separator)
