import {
  isArray,
  isArrayBuffer,
  isArrayBufferView,
  isAsyncGenerator,
  isAsyncIterable,
  isBoolean,
  isFunction,
  isGenerator,
  isNumber,
  isObject,
  isPromise,
  isSharedArrayBuffer,
  isString,
  isUndefined,
} from 'std:shared'

import { describe, expect, it } from 'bun:test'

describe('isPromise', () => {
  it('accepts anything thenable, rejects everything else', () => {
    expect(isPromise(Promise.resolve(1))).toBe(true)
    // oxlint-disable-next-line unicorn/no-thenable
    expect(isPromise({ then: () => {} })).toBe(true)

    // oxlint-disable-next-line unicorn/no-thenable
    expect(isPromise({ then: 1 })).toBe(false)
    expect(isPromise(null)).toBe(false)
    expect(isPromise(undefined)).toBe(false)
    expect(isPromise('pending')).toBe(false)
    expect(isPromise(() => {})).toBe(false)
  })
})

describe('primitive guards', () => {
  it('match their exact runtime type', () => {
    expect(isFunction(() => {})).toBe(true)
    expect(
      isFunction(
        class {
          n = 1
        },
      ),
    ).toBe(true)
    expect(isFunction('fn')).toBe(false)

    expect(isString('text')).toBe(true)
    expect(isString(1)).toBe(false)

    expect(isBoolean(false)).toBe(true)
    expect(isBoolean(0)).toBe(false)

    expect(isNumber(3.14)).toBe(true)
    expect(isNumber(Number.NaN)).toBe(true) // NaN is still typeof number
    expect(isNumber('3')).toBe(false)

    expect(isUndefined(undefined)).toBe(true)
    expect(isUndefined(null)).toBe(false)

    expect(isArray([1])).toBe(true)
    expect(isArray('not')).toBe(false)
  })

  it('isObject means non-null, non-array object — class instances included', () => {
    expect(isObject({})).toBe(true)
    expect(isObject(new Date())).toBe(true)

    expect(isObject([])).toBe(false)
    expect(isObject(null)).toBe(false)
    expect(isObject(() => {})).toBe(false)
  })
})

describe('iterator guards', () => {
  it('isGenerator is structural: next + Symbol.iterator', () => {
    expect(isGenerator((function* () {})())).toBe(true)
    expect(isGenerator([1][Symbol.iterator]())).toBe(true) // array iterators qualify too

    expect(isGenerator(function* () {})).toBe(false) // the function, not its generator
    expect(isGenerator([1])).toBe(false) // iterable but no next()
    expect(isGenerator(null)).toBe(false)
  })

  it('async variants require Symbol.asyncIterator', () => {
    const asyncGenerator = (async function* () {})()

    expect(isAsyncGenerator(asyncGenerator)).toBe(true)
    expect(isAsyncIterable(asyncGenerator)).toBe(true)

    expect(isAsyncGenerator((function* () {})())).toBe(false)
    expect(isAsyncIterable([1])).toBe(false)
    expect(isAsyncIterable(null)).toBe(false)
  })
})

describe('buffer guards', () => {
  it('distinguish buffers, shared buffers and views', () => {
    const buffer = new ArrayBuffer(8)
    const shared = new SharedArrayBuffer(8)
    const view = new Uint8Array(buffer)

    expect(isArrayBuffer(buffer)).toBe(true)
    expect(isArrayBuffer(shared)).toBe(false)
    expect(isArrayBuffer(view)).toBe(false)

    expect(isSharedArrayBuffer(shared)).toBe(true)
    expect(isSharedArrayBuffer(buffer)).toBe(false)

    expect(isArrayBufferView(view)).toBe(true)
    expect(isArrayBufferView(new DataView(buffer))).toBe(true)
    expect(isArrayBufferView(buffer)).toBe(false)
  })
})
