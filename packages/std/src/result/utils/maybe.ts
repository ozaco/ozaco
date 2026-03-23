import { MAYBE_JUST, MAYBE_NOTHING } from '../const'

import type { Impl } from '../types/impl'
import type { Maybe } from '../types/maybe'

export const just = (value => {
  if (typeof value === 'undefined') {
    return { _t: MAYBE_JUST } as Maybe<typeof value>
  }
  return { _t: MAYBE_JUST, value }
}) as Impl.Just

export const nothing: Impl.Nothing = () => ({
  _t: MAYBE_NOTHING,
})
