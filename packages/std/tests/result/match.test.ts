/**
 * A `createTags` entry given as `[name, matcher]` says which foreign value (a thrown JS / platform /
 * third-party error) its tag stands for; `asFailure(value, bundle)` folds a matching value into
 * it — the value kept as `raw`, its own `message` (else `code`) the failure's — and anything else
 * into `std:result.unknown`. `code` / `name` compare one value or any of a list (both given: both
 * must match); a function decides by itself. First match wins, in declaration order.
 */
import { ResultErrors, asFailure, fail, isFailure, throwable } from 'std:result'
import { TAG_MATCHERS, createTags } from 'std:shared'

import { describe, expect, it } from 'bun:test'

const coded = (code: unknown, message = 'platform text') =>
  Object.assign(new Error(message), { code })

const DiskErrors = createTags(
  'app:disk',

  'full',
  ['not-found', { code: 'ENOENT' }],
  ['access-denied', { code: ['EACCES', 'EPERM'] }],
  ['busy', { code: 'EBUSY', name: 'Error' }],
  ['timeout', value => value instanceof DOMException && value.name === 'TimeoutError'],
  ['any-coded', { code: ['ENOENT', 'EBADF'] }],
)

describe('createTags with matchers', () => {
  it('still is the tag bundle: PascalCase keys, dotted values, the matchers out of sight', () => {
    expect(DiskErrors.Full).toBe('app:disk.full')
    expect(DiskErrors.NotFound).toBe('app:disk.not-found')
    expect(DiskErrors.AccessDenied).toBe('app:disk.access-denied')
    expect(Object.keys(DiskErrors)).toEqual([
      'Full',
      'NotFound',
      'AccessDenied',
      'Busy',
      'Timeout',
      'AnyCoded',
    ])
    expect(JSON.stringify(DiskErrors)).toBe(
      JSON.stringify({
        Full: 'app:disk.full',
        NotFound: 'app:disk.not-found',
        AccessDenied: 'app:disk.access-denied',
        Busy: 'app:disk.busy',
        Timeout: 'app:disk.timeout',
        AnyCoded: 'app:disk.any-coded',
      }),
    )
    expect(DiskErrors[TAG_MATCHERS].map(([tag]) => tag)).toEqual([
      'app:disk.not-found',
      'app:disk.access-denied',
      'app:disk.busy',
      'app:disk.timeout',
      'app:disk.any-coded',
    ])
  })

  it('a bundle without matchers is still a bundle (it matches nothing)', () => {
    const Plain = createTags('app:plain', 'one')
    const error = coded('ENOENT')

    expect(asFailure(error, Plain).error).toBe(ResultErrors.Unknown)
    expect(asFailure(error, Plain).raw).toBe(error)
  })
})

describe('asFailure(value, bundle)', () => {
  it('folds a match into its tag: the own message, the value as raw, the causes appended', () => {
    const error = coded('ENOENT', "ENOENT: no such file or directory, open '/x'")
    const failure = asFailure(error, DiskErrors, 'reading /x')

    expect(failure.error).toBe(DiskErrors.NotFound)
    expect(failure.message).toBe("ENOENT: no such file or directory, open '/x'")
    expect(failure.raw).toBe(error)
    expect(failure.causes).toEqual(['reading /x'])
  })

  it('a list matches any of its values; code and name together must both match', () => {
    expect(asFailure(coded('EPERM'), DiskErrors).error).toBe(DiskErrors.AccessDenied)
    expect(asFailure(coded('EBUSY'), DiskErrors).error).toBe(DiskErrors.Busy)

    const renamed = Object.assign(coded('EBUSY'), { name: 'SystemError' })

    expect(asFailure(renamed, DiskErrors).error).toBe(ResultErrors.Unknown)
  })

  it('the first matcher wins, in declaration order', () => {
    expect(asFailure(coded('ENOENT'), DiskErrors).error).toBe(DiskErrors.NotFound)
    expect(asFailure(coded('EBADF'), DiskErrors).error).toBe(DiskErrors.AnyCoded)
  })

  it('a function decides by itself; a throwing one is no match', () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError')

    expect(asFailure(timeout, DiskErrors).error).toBe(DiskErrors.Timeout)

    const Fragile = createTags('app:fragile', [
      'never',
      () => {
        throw new Error('the matcher broke')
      },
    ])

    expect(asFailure(new Error('x'), Fragile).error).toBe(ResultErrors.Unknown)
  })

  it('matches plain objects and primitives too, never by instanceof', () => {
    expect(asFailure({ code: 'ENOENT' }, DiskErrors).error).toBe(DiskErrors.NotFound)
    // no message: the code is the text
    expect(asFailure({ code: 'ENOENT' }, DiskErrors).message).toBe('ENOENT')
    expect(asFailure('ENOENT', DiskErrors).error).toBe(ResultErrors.Unknown)
    expect(asFailure(null, DiskErrors).error).toBe(ResultErrors.Unknown)
  })

  it('an unmatched value is std:result.unknown, its serialized text the message', () => {
    const error = coded('EIO', 'i/o error')
    const failure = asFailure(error, DiskErrors)

    expect(failure.error).toBe(ResultErrors.Unknown)
    expect(failure.message).toBe('Error: i/o error (EIO)')
    expect(failure.raw).toBe(error)
  })

  it('re-classifies a std:result.unknown fold (what the effect runtime made of a throw)', () => {
    const error = coded('EACCES')
    const fold = asFailure(error, 'opening')
    const failure = asFailure(fold, DiskErrors, 'reading')

    expect(failure).not.toBe(fold)
    expect(failure.error).toBe(DiskErrors.AccessDenied)
    expect(failure.message).toBe('platform text')
    expect(failure.raw).toBe(error)
    expect(failure.causes).toEqual(['opening', 'reading'])
    // the fold itself is untouched
    expect(fold.error).toBe(ResultErrors.Unknown)
    expect(fold.causes).toEqual(['opening'])
  })

  it('never re-classifies a tagged failure, nor an unknown one without raw', () => {
    const tagged = fail('app:x.failed', 'boom')

    expect(asFailure(tagged, DiskErrors)).toBe(tagged)

    const remote = fail(ResultErrors.Unknown, 'Error: x (ENOENT)')

    expect(asFailure(remote, DiskErrors)).toBe(remote)

    // an unmatched fold stays the same object
    const fold = asFailure(coded('EIO'))

    expect(asFailure(fold, DiskErrors)).toBe(fold)
  })

  it('is typed: a Failure input keeps its tag and gains the matched ones', () => {
    const typed = asFailure(fail('app:x.failed'), DiskErrors)
    const tag:
      | 'app:x.failed'
      | 'app:disk.not-found'
      | 'app:disk.access-denied'
      | 'app:disk.busy'
      | 'app:disk.timeout'
      | 'app:disk.any-coded' = typed.error

    expect(tag).toBe('app:x.failed')
  })
})

describe('throwable(cb, bundle)', () => {
  it('folds the throw through the bundle, sync and async', async () => {
    const sync = throwable(() => {
      throw coded('ENOENT')
    }, DiskErrors)
    const rejected = await throwable(() => Promise.reject(coded('EPERM')), DiskErrors, 'saving')

    expect(isFailure(sync) && sync.error).toBe(DiskErrors.NotFound)
    expect(isFailure(rejected) && rejected.error).toBe(DiskErrors.AccessDenied)
    expect(isFailure(rejected) && rejected.causes).toEqual(['saving'])
  })
})
