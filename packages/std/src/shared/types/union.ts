import type { BlobType } from './common'

export type UnionToIntersection<U> = (U extends BlobType ? (x: U) => void : never) extends (x: infer R) => void
  ? R
  : never

export type LastInUnion<U> = UnionToIntersection<U extends BlobType ? () => U : never> extends () => infer R ? R : never

export type UnionToTuple<U, Last = LastInUnion<U>> = [
  U,
] extends [
  never,
]
  ? []
  : [
      ...UnionToTuple<Exclude<U, Last>>,
      Last,
    ]
