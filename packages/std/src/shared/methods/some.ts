export const some =
  <T>(predicate: (value: T, index: number) => boolean) =>
  (input: Iterable<T>): boolean => {
    let i = 0
    for (const v of input) {
      if (predicate(v, i++)) {
        return true
      }
    }
    return false
  }
