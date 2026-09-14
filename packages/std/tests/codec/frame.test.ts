import { Codec } from 'std:codec'
import { run } from 'std:effect'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import { fakeCodec } from '../helpers/fake-codec'

const encoder = new TextEncoder()

describe('Codec.actions.encodeFrame', () => {
  it('passes strings through untouched (no codec involved)', async () => {
    const outcome = await run(function* () {
      // no codec installed at all: a string frame must never reach the registry
      return yield* Codec.actions.encodeFrame<string>('already text')
    })

    expect(unwrap(outcome)).toBe('already text')
  })

  it('passes binary (typed arrays and ArrayBuffers) through by reference', async () => {
    const view = encoder.encode('bytes')
    const buffer = new ArrayBuffer(4)

    const outcome = await run(function* () {
      return {
        view: yield* Codec.actions.encodeFrame<Uint8Array>(view),
        buffer: yield* Codec.actions.encodeFrame<ArrayBuffer>(buffer),
      }
    })

    const result = unwrap(outcome)
    expect(result.view).toBe(view)
    expect(result.buffer).toBe(buffer)
  })

  it('stringifies everything else through the routed codec', async () => {
    const outcome = await run(function* () {
      yield* JsonCodec.use()
      return {
        object: yield* Codec.actions.encodeFrame<string>({ a: 1, b: ['x'] }),
        number: yield* Codec.actions.encodeFrame<string>(42),
        nil: yield* Codec.actions.encodeFrame<string>(null),
      }
    })

    expect(unwrap(outcome)).toEqual({ object: '{"a":1,"b":["x"]}', number: '42', nil: 'null' })
  })

  it('a `preferred` codec pins the stringify instead of routing by priority', async () => {
    const High = fakeCodec('fake-frame')

    const outcome = await run(function* () {
      yield* JsonCodec.use()
      yield* High.use({ priority: 5000 })

      return {
        routed: yield* Codec.actions.encodeFrame<string>({ n: 1 }),
        pinned: yield* Codec.actions.encodeFrame<string>({ n: 1 }, JsonCodec),
      }
    })

    expect(unwrap(outcome)).toEqual({ routed: 'fake-frame:{"n":1}', pinned: '{"n":1}' })
  })
})

describe('Codec.actions.decodeFrame', () => {
  it('parses a JSON-looking string (object or array, surrounding whitespace allowed)', async () => {
    const outcome = await run(function* () {
      yield* JsonCodec.use()
      return {
        object: yield* Codec.actions.decodeFrame('{"a":1}'),
        array: yield* Codec.actions.decodeFrame('  [1, 2, 3]\n'),
      }
    })

    expect(unwrap(outcome)).toEqual({ object: { a: 1 }, array: [1, 2, 3] })
  })

  it('returns a non-JSON-looking string as-is without touching the codec', async () => {
    const outcome = await run(function* () {
      // no codec installed: a plain string must not trigger a parse (which would fail missing-action)
      return {
        plain: yield* Codec.actions.decodeFrame('hello world'),
        quoted: yield* Codec.actions.decodeFrame('"a json string"'),
        number: yield* Codec.actions.decodeFrame('42'),
      }
    })

    expect(unwrap(outcome)).toEqual({
      plain: 'hello world',
      quoted: '"a json string"',
      number: '42',
    })
  })

  it('returns a JSON-looking but invalid string as-is (parse failure is swallowed)', async () => {
    const outcome = await run(function* () {
      yield* JsonCodec.use()
      return {
        object: yield* Codec.actions.decodeFrame('{"broken":'),
        array: yield* Codec.actions.decodeFrame('[1, 2'),
      }
    })

    expect(unwrap(outcome)).toEqual({ object: '{"broken":', array: '[1, 2' })
  })

  it('passes non-string data through by reference', async () => {
    const bytes = encoder.encode('{"a":1}')
    const object = { already: 'decoded' }

    const outcome = await run(function* () {
      yield* JsonCodec.use()
      return {
        bytes: yield* Codec.actions.decodeFrame<Uint8Array>(bytes),
        object: yield* Codec.actions.decodeFrame<typeof object>(object),
        number: yield* Codec.actions.decodeFrame<number>(7),
      }
    })

    const result = unwrap(outcome)
    expect(result.bytes).toBe(bytes)
    expect(result.object).toBe(object)
    expect(result.number).toBe(7)
  })

  it('a `preferred` codec pins the parse instead of routing by priority', async () => {
    const High = fakeCodec('fake-frame-2')

    const outcome = await run(function* () {
      yield* JsonCodec.use()
      yield* High.use({ priority: 5000 })

      // the fake codec's parse strips a label prefix, so routing to it mangles plain JSON;
      // pinning JsonCodec bypasses it
      return {
        routed: yield* Codec.actions.decodeFrame('{"n":1}'),
        pinned: yield* Codec.actions.decodeFrame('{"n":1}', JsonCodec),
      }
    })

    const result = unwrap(outcome)
    expect(result.pinned).toEqual({ n: 1 })
    expect(result.routed).not.toEqual({ n: 1 })
  })
})
