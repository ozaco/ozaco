import type { BlobType } from '../../shared'

import type { Ok } from './ok'

/**
 * This class represents a failed result
 */
export class Err<
  T = never,
  const N extends Std.ErrorValues = never,
  const C extends Std.ErrorValues[] = [],
> implements Std.ResultType<T, N, C>
{
  constructor(
    // biome-ignore lint/nursery/useConsistentMemberAccessibility: Redundant
    public name: N,
    // biome-ignore lint/nursery/useConsistentMemberAccessibility: Redundant
    public message: string,
    // biome-ignore lint/nursery/useConsistentMemberAccessibility: Redundant
    public causes = [] as unknown as C,
    // biome-ignore lint/nursery/useConsistentMemberAccessibility: Redundant
    public data: BlobType[] = [],
    // biome-ignore lint/nursery/useConsistentMemberAccessibility: Redundant
    public timestamp: number = Date.now()
  ) {}

  isOk(): this is Ok<T, N, C> {
    return false
  }

  isErr(): this is Err<T, N, C> {
    return true
  }

  unwrap(): never {
    return this.throw()
  }

  else<A>(value: A): T | A {
    return value
  }

  or<A extends Std.Result<BlobType, BlobType, BlobType>>(value: A) {
    return value
  }

  /**
   * append cause to error (checks last cause if its already appended)
   */
  appendCause<const A extends Std.ErrorValues[] = []>(...additionalCauses: A) {
    for (const additionalCause of additionalCauses) {
      if (additionalCause && this.causes[this.causes.length - 1] !== additionalCause) {
        this.causes.push(additionalCause)
      }
    }

    return this as unknown as Err<T, N, (C[number] | A[number])[]>
  }

  /**
   * append data to error (checks if its already appended)
   */
  appendData(...datas: BlobType[]) {
    for (const data of datas) {
      if (!this.data.includes(data)) {
        this.data.push(data)
      }
    }

    return this
  }

  /**
   * throws without using unwrap
   */
  throw<const A extends Std.ErrorValues[] = []>(...additionalCauses: A): never {
    throw this.appendCause(...additionalCauses)
  }

  *[Symbol.iterator](): Generator<Err<never, N, C>, T> {
    // biome-ignore lint/complexity/noUselessThisAlias: Redundant
    const self = this
    // @ts-expect-error -- This is structurally equivalent and safe
    yield self
    // @ts-expect-error -- This is structurally equivalent and safe
    return self
  }
}

/**
 * Shortcut for creating failed result
 */
export function err<T = never, const N extends Std.ErrorValues = never>(
  name: N,
  message: string
): Err<T, N, []> {
  return new Err(name, message)
}
