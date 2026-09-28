import { lazyPromise, lazyPromiseWithResolvers } from 'std:result'

import { describe, expect, it } from 'bun:test'

describe('lazyPromise', () => {
  it('defers the resolver until first consumption and reifies exactly once', async () => {
    let calls = 0
    const promise = lazyPromise<number, never>(resolve => {
      calls += 1
      resolve(7)
    })

    expect(calls).toBe(0)

    expect(await promise).toBe(7)
    expect(await promise).toBe(7)
    expect(calls).toBe(1)
  })
})

describe('lazyPromiseWithResolvers', () => {
  it('resolves consumers whether settled before or after consumption starts', async () => {
    const early = lazyPromiseWithResolvers<string>()

    early.resolve('before')
    expect(await early.promise).toBe('before')

    const late = lazyPromiseWithResolvers<string>()
    const pending = late.promise.then(value => `got:${value}`)

    late.resolve('after')
    expect(await pending).toBe('got:after')
  })

  it('rejects with the original error; the first settle wins', async () => {
    const rejected = lazyPromiseWithResolvers<never>()
    const boom = new Error('kaput')

    rejected.reject(boom)

    let caught: unknown

    try {
      await rejected.promise
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(boom)

    const raced = lazyPromiseWithResolvers<string>()

    raced.resolve('first')
    raced.reject(new Error('second'))
    expect(await raced.promise).toBe('first')
  })
})
