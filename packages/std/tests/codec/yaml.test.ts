import { Codec, CodecErrors } from 'std:codec'
import type { Flow } from 'std:effect'
import { attempt, createChannel, run, sleep, spawn, withResolvers } from 'std:effect'
import type { Result } from 'std:result'
import { fail, isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { YamlCodec } from 'std:codec/impl/yaml'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Subscribe to `flow`, collect every value and resolve with the values + the close value. */
const drain = function* <T>(flow: Flow<unknown, unknown>) {
  const done = withResolvers<{ values: T[]; close: unknown }>()
  yield* spawn(function* () {
    const values: T[] = []
    const subscription = yield* flow
    for (;;) {
      const next = yield* subscription.next()
      if (next.done) {
        done.resolve({ values, close: next.value })
        return
      }
      values.push(next.value as T)
    }
  })
  // let the pipeline subscribe before the caller feeds it
  yield* sleep(1)
  return done.operation
}

describe('yaml codec', () => {
  it('registers as `std/yaml-codec` at priority 500', async () => {
    const outcome = await run(function* () {
      const ctx = yield* YamlCodec.use()
      return { ctx, transports: (yield* Codec.actions.getTransports()).length }
    })

    expect(unwrap(outcome)).toEqual({
      ctx: { name: 'std/yaml-codec', priority: 500 },
      transports: 1,
    })
  })

  it('encode/decode round-trip bytes; stringify/parse round-trip text', async () => {
    const payload = {
      title: 'demo — café',
      port: 8080,
      ratio: 0.5,
      on: true,
      tags: ['a', 'b'],
      server: { host: 'local', nested: { deep: 1 } },
    }

    const outcome = await run(function* () {
      yield* YamlCodec.use()

      const bytes = yield* YamlCodec.actions.encode(payload)
      const text = yield* YamlCodec.actions.stringify(payload)

      return {
        isBytes: bytes instanceof Uint8Array,
        sameText: decoder.decode(bytes) === text,
        hasKey: text.includes('server:'),
        decoded: yield* YamlCodec.actions.decode(bytes),
        parsed: yield* YamlCodec.actions.parse(text),
      }
    })

    expect(unwrap(outcome)).toEqual({
      isBytes: true,
      sameText: true,
      hasKey: true,
      decoded: payload,
      parsed: payload,
    })
  })

  it('routes through the protocol when it is the only codec installed', async () => {
    const outcome = await run(function* () {
      yield* YamlCodec.use()
      const text = yield* Codec.actions.stringify({ key: 'value' })
      return { text, back: yield* Codec.actions.parse(text) }
    })

    expect(unwrap(outcome)).toEqual({ text: 'key: value\n', back: { key: 'value' } })
  })

  it('parses scalar and sequence roots (YAML is not table-only)', async () => {
    const outcome = await run(function* () {
      yield* YamlCodec.use()
      return {
        list: yield* YamlCodec.actions.parse('- 1\n- two\n'),
        scalar: yield* YamlCodec.actions.parse('42\n'),
        text: yield* YamlCodec.actions.stringify(['x', 'z']),
      }
    })

    expect(unwrap(outcome)).toEqual({ list: [1, 'two'], scalar: 42, text: '- x\n- z\n' })
  })

  it('malformed input fails with `CodecErrors.Parse` / `CodecErrors.Decode`, never throws', async () => {
    const outcome = await run(function* () {
      yield* YamlCodec.use()

      const parsed = yield* attempt(() => YamlCodec.actions.parse('key: [unclosed'))
      const decoded = yield* attempt(() => YamlCodec.actions.decode(encoder.encode('a: b: c')))

      return {
        parse: isFailure(parsed) ? parsed.error : 'no-failure',
        decode: isFailure(decoded) ? decoded.error : 'no-failure',
      }
    })

    expect(unwrap(outcome)).toEqual({ parse: CodecErrors.Parse, decode: CodecErrors.Decode })
  })

  it('an undumpable value fails with `CodecErrors.Stringify` / `CodecErrors.Encode`', async () => {
    const outcome = await run(function* () {
      yield* YamlCodec.use()

      const text = yield* attempt(() => YamlCodec.actions.stringify({ fn: () => 1 }))
      const bytes = yield* attempt(() => YamlCodec.actions.encode({ fn: () => 1 }))

      return {
        stringify: isFailure(text) ? text.error : 'no-failure',
        encode: isFailure(bytes) ? bytes.error : 'no-failure',
      }
    })

    expect(unwrap(outcome)).toEqual({
      stringify: CodecErrors.Stringify,
      encode: CodecErrors.Encode,
    })
  })

  describe('streaming', () => {
    it('encodeFlow emits one YAML document per chunk', async () => {
      const outcome = await run(function* () {
        yield* YamlCodec.use()

        const source = createChannel<unknown, true | Result.Failure<unknown>>()
        const encoded = yield* YamlCodec.actions.encodeFlow(source)
        const collected = yield* drain<Uint8Array>(encoded)

        yield* source.send({ a: 1 })
        yield* source.send({ b: 'two' })
        yield* source.close(true)

        const { values, close } = yield* collected
        return { texts: values.map(chunk => decoder.decode(chunk)), close }
      })

      expect(unwrap(outcome)).toEqual({ texts: ['a: 1\n', 'b: two\n'], close: true })
    })

    it('decodeFlow is a whole-document decoder: it emits ONE value after the source closes', async () => {
      const outcome = await run(function* () {
        yield* YamlCodec.use()

        const source = createChannel<Uint8Array, true | Result.Failure<unknown>>()
        const decoded = yield* YamlCodec.actions.decodeFlow(source)
        const collected = yield* drain<unknown>(decoded)

        // split INSIDE the two-byte 'é' (0xC3 0xA9) — the stream decoder must reassemble it
        const bytes = encoder.encode('name: café\nserver:\n  port: 1\n')
        const splitAt = bytes.indexOf(0xc3) + 1
        yield* source.send(bytes.slice(0, splitAt))
        yield* source.send(bytes.slice(splitAt))
        yield* source.close(true)

        return yield* collected
      })

      expect(unwrap(outcome)).toEqual({
        values: [{ name: 'café', server: { port: 1 } }],
        close: true,
      })
    })

    it('encodeFlow → decodeFlow round-trips (disjoint chunks merge into one document)', async () => {
      const outcome = await run(function* () {
        yield* YamlCodec.use()

        const source = createChannel<unknown, true | Result.Failure<unknown>>()
        const decoded = yield* YamlCodec.actions.decodeFlow(
          yield* YamlCodec.actions.encodeFlow(source),
        )
        const collected = yield* drain<unknown>(decoded)

        yield* source.send({ a: 1 })
        yield* source.send({ b: { c: 'x' } })
        yield* source.close(true)

        return yield* collected
      })

      expect(unwrap(outcome)).toEqual({ values: [{ a: 1, b: { c: 'x' } }], close: true })
    })

    it('a malformed YAML stream currently FAILS the enclosing scope (pins AUDIT C13)', async () => {
      // AUDIT C13: on a parse error the forked decoder sets the channel close to the Failure AND
      // `return yield* fail(...)`s — raising out of a supervised fork nobody awaits, which crashes the
      // owner scope with `CodecErrors.Decode` (JsonCodec only closes the channel). This test pins the
      // CURRENT behavior so a fix shows up as a deliberate assertion change, not a silent one.
      const outcome = await run(function* () {
        yield* YamlCodec.use()

        const source = createChannel<Uint8Array, true | Result.Failure<unknown>>()
        const decoded = yield* YamlCodec.actions.decodeFlow(source)
        const collected = yield* drain<unknown>(decoded)

        yield* source.send(encoder.encode('key: ['))
        yield* source.send(encoder.encode('unclosed\n'))
        yield* source.close(true)

        return yield* collected
      })

      expect(isFailure(outcome)).toBe(true)
      if (isFailure(outcome)) {
        expect(outcome.error).toBe(CodecErrors.Decode)
      }
    })

    it('encodeFlow forwards a Failure close from its source', async () => {
      const outcome = await run(function* () {
        yield* YamlCodec.use()

        const source = createChannel<unknown, true | Result.Failure<unknown>>()
        const encoded = yield* YamlCodec.actions.encodeFlow(source)
        const collected = yield* drain<Uint8Array>(encoded)

        yield* source.send({ a: 1 })
        yield* source.close(fail('upstream', 'truncated') as Result.Failure<unknown>)

        const { values, close } = yield* collected
        return {
          count: values.length,
          close: isFailure(close) ? close.error : close,
        }
      })

      expect(unwrap(outcome)).toEqual({ count: 1, close: 'upstream' })
    })

    it('decodeFlow currently SWALLOWS a Failure close from its source (pins AUDIT C12)', async () => {
      // AUDIT C12: toml/yaml `decodeFlow` never reads the source's close value — it only checks
      // `next.done` — so an upstream failure close is dropped: the bytes received so far are parsed
      // as a complete document and the decode channel closes cleanly. `JsonCodec.decodeFlow` and this
      // file's own `encodeFlow` forward the failure. This test pins the CURRENT behavior so a fix
      // shows up as a deliberate assertion change, not a silent one.
      const outcome = await run(function* () {
        yield* YamlCodec.use()

        const source = createChannel<Uint8Array, true | Result.Failure<unknown>>()
        const decoded = yield* YamlCodec.actions.decodeFlow(source)
        const collected = yield* drain<unknown>(decoded)

        yield* source.send(encoder.encode('a: 1\n'))
        yield* source.close(fail('upstream', 'truncated') as Result.Failure<unknown>)

        return yield* collected
      })

      expect(unwrap(outcome)).toEqual({ values: [{ a: 1 }], close: true })
    })
  })
})
