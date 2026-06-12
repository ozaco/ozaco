import type { MAYBE_JUST, MAYBE_NOTHING } from '../const'

export type Maybe<T> = Maybe.Nothing<T> | Maybe.Just<T>

export namespace Maybe {
  export type Just<T> = {
    readonly _t: typeof MAYBE_JUST
    readonly value: T
  }

  export type Nothing<_T> = {
    readonly _t: typeof MAYBE_NOTHING
  }
}
