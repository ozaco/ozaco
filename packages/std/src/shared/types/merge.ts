export type Merge<A, B> = {
  [K in keyof A | keyof B]: K extends keyof A & keyof B
    ? A[K] | B[K]
    : K extends keyof B
      ? B[K]
      : K extends keyof A
        ? A[K]
        : never
}

export type Simplify<T> = T extends object ? { [K in keyof T]: Simplify<T[K]> } : T

export type MergeSimplified<A, B> = Simplify<Merge<A, B>>
