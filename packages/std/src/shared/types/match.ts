import type { GuardValue } from './common'
import type { StandardSchemaV1 } from './schema'

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

  /** Every case covered: callable with no argument. Cases left: the signature demands the
   * unhandled remainder, so `exhaustive()` is a compile error naming what is missing — at
   * runtime an unmatched value fails `shared.non-exhaustive` either way. */
  exhaustive: [Remaining] extends [never] ? () => Output : (unhandled: Remaining) => never

  run: () => Output | undefined
}
