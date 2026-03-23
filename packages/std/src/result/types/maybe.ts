import type { MAYBE_JUST, MAYBE_NOTHING } from '../const'

export type Just<T> = {
  readonly _t: typeof MAYBE_JUST
  readonly value: T
}

export type Nothing<_T> = {
  readonly _t: typeof MAYBE_NOTHING
}

export type Maybe<T> = Nothing<T> | Just<T>
