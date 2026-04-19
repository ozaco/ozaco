export interface Partition {
  <T, S extends T>(
    predicate: (value: T, index: number) => value is S,
  ): (input: Iterable<T>) => [S[], Exclude<T, S>[]]
  <T>(predicate: (value: T, index: number) => boolean): (input: Iterable<T>) => [T[], T[]]
}

export const partition = (<T>(predicate: (value: T, index: number) => boolean) =>
  (input: Iterable<T>): [T[], T[]] => {
    const pass: T[] = []
    const fail: T[] = []
    let i = 0
    for (const v of input) {
      ;(predicate(v, i++) ? pass : fail).push(v)
    }
    return [pass, fail]
  }) as Partition
