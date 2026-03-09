import type { MatchBuilder } from '../types/builder'

import { createBuilder } from '../internal/builder'

export const match = <const T>(value: T) => {
  return createBuilder(value, []) as unknown as MatchBuilder<T, T, never>
}
