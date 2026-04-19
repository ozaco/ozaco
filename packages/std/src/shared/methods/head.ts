export const head =
  <T>() =>
  (input: Iterable<T>): T | undefined => {
    for (const v of input) {
      return v
    }
    return undefined
  }
