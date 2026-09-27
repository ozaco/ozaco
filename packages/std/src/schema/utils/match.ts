import { createBuilder } from '../internal/builder'
import type { MatchBuilder } from '../types/match'

export const match = <const T>(value: T) =>
  createBuilder(value, []) as unknown as MatchBuilder<T, T, never>
