export const groupBy =
  <T, K extends PropertyKey>(keyFn: (value: T) => K) =>
  (input: Iterable<T>): Record<K, T[]> => {
    const result = {} as Record<K, T[]>
    for (const item of input) {
      const key = keyFn(item)
      ;(result[key] ??= []).push(item)
    }
    return result
  }
