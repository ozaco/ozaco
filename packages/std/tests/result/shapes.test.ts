/**
 * The result module's declared shapes agree with the runtime:
 * `throwable` over an async callback resolves a Result, `unwrap` passes non-Results through on both
 * paths, `asFailure` takes any number of causes, a Failure default of `auto` types as a Failure,
 * the bare constructors carry every declared field, and `ResultDef` is importable.
 */
import type { Result, ResultDef } from 'std:result'
import {
  asFailure,
  asFailureFrom,
  auto,
  fail,
  isFailure,
  isJust,
  isSuccess,
  just,
  succeed,
  throwable,
  unwrap,
} from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

describe('result — declared shapes vs runtime', () => {
  it('throwable over an async callback is typed Promise<Result> — no cast needed', async () => {
    const ok: Promise<Result<number, Error>> = throwable(() => Promise.resolve(21))
    expect(unwrap(await ok)).toBe(21)

    const failed = await throwable(() => Promise.reject(new RangeError('async boom')), RangeError)
    expect(isFailure(failed)).toBe(true)
    if (isFailure(failed)) {
      expect(failed.error).toBeInstanceOf(RangeError)
      expect(failed.message).toBe('from throwable')
    }

    // the sync overload is untouched
    const sync: Result<number, Error> = throwable(() => 2)
    expect(unwrap(sync)).toBe(2)
  })

  it('unwrap passes a non-Result through on the sync AND the promise path', async () => {
    expect(unwrap(42 as AnyType) as number).toBe(42)
    expect((await unwrap(Promise.resolve(42) as AnyType)) as number).toBe(42)
    expect(await unwrap(Promise.resolve(succeed(7)))).toBe(7)
    expect(await unwrap(Promise.resolve(fail('late')) as AnyType, 'fallback')).toBe('fallback')
  })

  it('asFailure / asFailureFrom append every cause given', () => {
    const decorated = asFailure(fail('base', 'msg', 'first'), 'second', 'third')
    expect(decorated.causes).toEqual(['first', 'second', 'third'])

    const folded = asFailureFrom(new Error('thrown'), 'a', 'b')
    expect(isFailure(folded)).toBe(true)
    expect(folded.causes).toEqual(['a', 'b'])

    // no cause appends nothing — not an `undefined` entry
    expect(asFailure(new Error('x')).causes).toEqual([])
  })

  it('a Failure default of auto() is typed — and is — a Failure', () => {
    const fallback = fail('fallback.tag')
    const outcome = auto(fail('original') as Result<number, string>, fallback)

    // the declared type keeps the Failure arm: this assignment must compile
    const typed: Result<number, 'fallback.tag'> = outcome
    expect(isFailure(typed)).toBe(true)
    expect(typed).toBe(fallback)

    // a plain default still wraps as a Success
    const wrapped = auto(fail('original') as Result<number, string>, 'plain')
    expect(isSuccess(wrapped) && wrapped.value).toBe('plain')
  })

  it('the bare constructors carry every field the types declare', () => {
    const unit = succeed()
    expect('value' in unit).toBe(true)
    expect(unit.value).toBeUndefined()

    const bare = fail()
    expect('error' in bare).toBe(true)
    expect(bare.error).toBeUndefined()
    expect(bare.message).toBe('')
    expect(bare.causes).toEqual([])

    const empty = just()
    expect('value' in empty).toBe(true)
    expect(isJust(empty) ? empty.value : 'missing').toBeUndefined()
  })

  it('ResultDef is the exported namespace the built types refer to', () => {
    const mySucceed: ResultDef.Succeed = succeed
    const myFail: ResultDef.Fail = fail
    const myUnwrap: ResultDef.Unwrap = unwrap
    expect(typeof mySucceed).toBe('function')
    expect(typeof myFail).toBe('function')
    expect(typeof myUnwrap).toBe('function')
  })
})
