import type { BlobType } from '../../shared'

import { Err } from './err'

/**
 * This class represents a successful result
 */
export class Ok<T, const N extends Std.ErrorValues = never, const C extends Std.ErrorValues[] = []>
  implements Std.ResultType<T, N, C>
{
  constructor(readonly value: T) {
    if (value instanceof Ok) {
      this.value = value.value
    }
  }

  isOk(): this is Ok<T, N, C> {
    return true
  }

  isErr(): this is Err<T, N, C> {
    return false
  }

  unwrap(): T {
    return this.value
  }

  else<A>(_value: A): T | A {
    return this.value
  }

  or<A extends Std.Result<BlobType, BlobType, BlobType>>(_value: A) {
    return this
  }

  // biome-ignore lint/correctness/useYield: Redundant
  *[Symbol.iterator](): Generator<Err<never, N, C>, T> {
    return this.value
  }
}

/**
 * Shortcut for creating successful result
 */
export const ok = <T>(value: T) =>
  (value instanceof Err ? value : new Ok(value)) as Std.OkResolver<T>
