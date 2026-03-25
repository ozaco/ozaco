export const take =
  <T>(n: number) =>
  (input: Iterable<T>): T[] => {
    const result: T[] = []
    for (const v of input) {
      if (result.length >= n) {
        break
      }
      result.push(v)
    }
    return result
  }
