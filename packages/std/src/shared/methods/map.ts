export const map =
  <T, U>(fn: (value: T, index: number) => U) =>
  (input: Iterable<T>): U[] => {
    const result: U[] = []
    let i = 0
    for (const v of input) {
      result.push(fn(v, i++))
    }
    return result
  }
