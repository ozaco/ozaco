import type { BlobType } from './common'

export type ToPartialObect<T> = T extends object ? Partial<T> : T

// Union

export type UnionToIntersection<T> = (T extends BlobType ? (x: T) => void : never) extends (x: infer S) => void
  ? S
  : never

export type LastInUnion<T> = UnionToIntersection<T extends BlobType ? () => T : never> extends () => infer S ? S : never

export type UnionToTuple<T, Last = LastInUnion<T>> = [
  T,
] extends [
  never,
]
  ? []
  : [
      ...UnionToTuple<Exclude<T, Last>>,
      Last,
    ]
