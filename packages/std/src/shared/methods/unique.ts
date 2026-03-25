export const unique: {
  <T>(): (input: Iterable<T>) => T[]
  <T, K>(keyFn: (value: T) => K): (input: Iterable<T>) => T[]
} =
  <T, K>(keyFn?: (value: T) => K) =>
  (input: Iterable<T>): T[] => {
    if (!keyFn) {
      return [...new Set(input)]
    }
    const seen = new Set<K>()
    const result: T[] = []
    for (const item of input) {
      const key = keyFn(item)
      if (!seen.has(key)) {
        seen.add(key)
        result.push(item)
      }
    }
    return result
  }
