export const every =
  <T>(predicate: (value: T, index: number) => boolean) =>
  (input: Iterable<T>): boolean => {
    let i = 0
    for (const v of input) {
      if (!predicate(v, i++)) {
        return false
      }
    }
    return true
  }
