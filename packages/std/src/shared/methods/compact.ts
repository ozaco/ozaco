export const compact =
  <T>() =>
  (input: Iterable<T>): Exclude<T, null | undefined | false | 0 | ''>[] => {
    const result: Exclude<T, null | undefined | false | 0 | ''>[] = []
    for (const v of input) {
      if (v) {
        result.push(v as Exclude<T, null | undefined | false | 0 | ''>)
      }
    }
    return result
  }
