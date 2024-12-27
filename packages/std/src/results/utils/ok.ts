import type { BlobType } from '../../shared'

import type { Err } from './err'

/**
 * This class represents a successful result
 */
export class Ok<T, const N extends Std.ErrorValues = never, const C extends Std.ErrorValues[] = []>
  implements Std.ResultType<T, N, C>
{
  constructor(readonly value: T) {}

  isOk(): this is Ok<T, N, C> {
    return true
  }

  isErr(): this is Err<T, N, C> {
    return !this.isOk()
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
export const ok = <T>(value: T) => new Ok(value)
