import {
  PriorityQueue,
  createTags,
  hasFlag,
  kebabToPascal,
  lazyPromise,
  lazyPromiseWithResolvers,
  serializeError,
} from 'std:shared'

import { describe, expect, it } from 'bun:test'

describe('hasFlag', () => {
  it('reports whether ANY bit of the flag mask is set', () => {
    const READ = 0b001
    const WRITE = 0b010
    const EXEC = 0b100

    expect(hasFlag(READ | WRITE, READ)).toBe(true)
    expect(hasFlag(READ | WRITE, EXEC)).toBe(false)
    expect(hasFlag(READ | WRITE, WRITE | EXEC)).toBe(true) // partial mask overlap counts
    expect(hasFlag(0, READ)).toBe(false)
  })
})

describe('serializeError', () => {
  it('turns every error shape into a stable string', () => {
    expect(serializeError('plain text')).toBe('plain text')
    expect(serializeError(new Error('kaput'))).toBe('Error: kaput')

    const coded = Object.assign(new TypeError('denied'), { code: 'EACCES' })
    expect(serializeError(coded)).toBe('TypeError: denied (EACCES)')

    expect(serializeError(null)).toBe('null')
    expect(serializeError(undefined)).toBe('undefined')
    expect(serializeError(42)).toBe('42')
    expect(serializeError({ reason: 'bad' })).toBe('{"reason":"bad"}')

    // circular objects fall back to Object#toString instead of throwing
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(serializeError(circular)).toBe('[object Object]')
  })
})

describe('string / tags', () => {
  it('kebabToPascal upper-cases each dash segment and drops empties', () => {
    expect(kebabToPascal('config-file-loader')).toBe('ConfigFileLoader')
    expect(kebabToPascal('--double--dash')).toBe('DoubleDash')
    expect(kebabToPascal('solo')).toBe('Solo')
  })

  it('createTags maps kebab names to pascal keys, with or without a prefix', () => {
    expect(createTags('logger', 'file-transport', 'console')).toEqual({
      FileTransport: 'logger.file-transport',
      Console: 'logger.console',
    })
    expect(createTags(null, 'raw-key')).toEqual({ RawKey: 'raw-key' })
  })
})

describe('PriorityQueue', () => {
  it('pops lower priorities first, FIFO within a tier, and drains to undefined', () => {
    const queue = new PriorityQueue<string>()
    const work: [number, string][] = [
      [5, 'background'],
      [1, 'urgent-1'],
      [1, 'urgent-2'],
      [3, 'normal'],
    ]
    for (const [priority, label] of work) {
      queue.push(priority, label)
    }

    expect([queue.pop(), queue.pop(), queue.pop(), queue.pop()]).toEqual([
      'urgent-1',
      'urgent-2',
      'normal',
      'background',
    ])
    expect(queue.pop()).toBeUndefined()

    // bounds reset after draining — new work at any priority is reachable again
    queue.push(2, 'revived')
    expect(queue.pop()).toBe('revived')
    expect(queue.pop()).toBeUndefined()
  })
})

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
