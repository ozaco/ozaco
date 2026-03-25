export const zip =
  <U>(other: Iterable<U>) =>
  <T>(input: Iterable<T>): [T, U][] => {
    const result: [T, U][] = []
    const otherIter = other[Symbol.iterator]()
    for (const item of input) {
      const next = otherIter.next()
      if (next.done) {
        break
      }
      result.push([item, next.value])
    }
    return result
  }
