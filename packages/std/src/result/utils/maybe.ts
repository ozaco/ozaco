import { MAYBE_JUST, MAYBE_NOTHING } from '../const'
import type { ResultDef } from '../types/def'

// `value` is always present, as the type says — `just()` is `just(undefined)`
export const just = ((value?: unknown) => ({ _t: MAYBE_JUST, value })) as ResultDef.Just

export const nothing: ResultDef.Nothing = () => ({
  _t: MAYBE_NOTHING,
})
