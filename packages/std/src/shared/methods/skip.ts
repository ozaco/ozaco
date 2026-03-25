export const skip =
  <T>(n: number) =>
  (input: Iterable<T>): T[] => {
    const result: T[] = []
    let i = 0
    for (const v of input) {
      if (i++ >= n) {
        result.push(v)
      }
    }
    return result
  }
