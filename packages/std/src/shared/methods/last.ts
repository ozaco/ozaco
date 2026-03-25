export const last =
  <T>() =>
  (input: Iterable<T>): T | undefined => {
    if (Array.isArray(input)) {
      return input.at(-1)
    }
    let result: T | undefined
    for (const v of input) {
      result = v
    }
    return result
  }
