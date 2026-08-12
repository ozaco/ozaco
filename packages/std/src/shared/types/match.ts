import type { Result } from 'std:result'

import type { AnyType, GuardValue } from './common'
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
    (
      predicate: (value: Remaining) => boolean,
      handler: boolean,
    ): MatchBuilder<Input, Remaining, Output | boolean>
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

  exhaustive: [Remaining] extends [never] ? () => Output : Result.Failure<Remaining>

  run: () => Output | undefined
}
