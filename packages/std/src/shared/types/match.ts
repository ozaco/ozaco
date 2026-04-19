import type { Failure } from 'std:result'

import type { GuardValue, AnyType } from './common'
import type { StandardSchemaV1 } from './schema'

export type MatchCase = {
  handler: (value: AnyType) => AnyType
  predicate?: (value: AnyType) => boolean
  schema?: StandardSchemaV1
}

export interface MatchBuilder<Input, Remaining, Output> {
  with: <S extends StandardSchemaV1, R>(
    schema: S,
    handler: (value: StandardSchemaV1.InferOutput<S>) => R,
  ) => MatchBuilder<Input, Exclude<Remaining, StandardSchemaV1.InferInput<S>>, Output | R>

  when: {
    <P extends (value: Remaining) => unknown, R, N extends Extract<Remaining, GuardValue<P>>>(
      predicate: P,
      handler: (value: N) => R,
    ): MatchBuilder<Input, Exclude<Remaining, N>, Output | R>
    <R>(
      predicate: (value: Remaining) => boolean,
      handler: (value: Remaining) => R,
    ): MatchBuilder<Input, Remaining, Output | R>
  }

  otherwise: <R>(handler: (value: Remaining) => R) => Output | R

  exhaustive: [Remaining] extends [never] ? () => Output : Failure<Remaining>

  run: () => Output | null
}
