import { PriorityQueue, createTags, hasFlag, kebabToPascal, serializeError } from 'std:shared'

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
    expect(createTags('logger', 'file-transport', 'console') as unknown).toEqual({
      FileTransport: 'logger.file-transport',
      Console: 'logger.console',
    })
    expect(createTags(null, 'raw-key') as unknown).toEqual({ RawKey: 'raw-key' })
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
