export const chunk =
  <T>(size: number) =>
  (input: Iterable<T>): T[][] => {
    const result: T[][] = []
    let current: T[] = []
    for (const item of input) {
      current.push(item)
      if (current.length === size) {
        result.push(current)
        current = []
      }
    }
    if (current.length > 0) {
      result.push(current)
    }
    return result
  }
