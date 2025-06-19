import type { BlobType } from '../../shared'

/**
 * This class represents a failed result
 */
export class Err<T = never, const N extends Std.ErrorValues = never, const C extends Std.ErrorValues[] = []> implements Std.ResultType<T, N, C> {
  constructor(
    // biome-ignore lint/style/useConsistentMemberAccessibility: Redundant
    public name: N,
    // biome-ignore lint/style/useConsistentMemberAccessibility: Redundant
    public message: string,
    // biome-ignore lint/style/useConsistentMemberAccessibility: Redundant
    public causes = [] as unknown as C,
    // biome-ignore lint/style/useConsistentMemberAccessibility: Redundant
    public data: BlobType[] = [],
    // biome-ignore lint/style/useConsistentMemberAccessibility: Redundant
    public timestamp: number = Date.now(),
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
      if (additionalCause && this.causes.at(-1) !== additionalCause) {
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
export const err = <T = never, const N extends Std.ErrorValues = never>(name: N, message: string) => new Err<T, N, []>(name, message)

/**
 * This class represents a successful result
 */
export class Ok<T, const N extends Std.ErrorValues = never, const C extends Std.ErrorValues[] = []> implements Std.ResultType<T, N, C> {
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
export const ok = <T>(value: T) => (value instanceof Err ? value : new Ok(value)) as Std.OkResolver<T>
