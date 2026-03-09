import type { Failure } from 'std:result'
import type { GuardValue, StandardSchemaV1 } from 'std:shared'

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
