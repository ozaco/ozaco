export const forEach =
  <T>(fn: (value: T, index: number) => void) =>
  (input: Iterable<T>): void => {
    let i = 0
    for (const v of input) {
      fn(v, i++)
    }
  }
