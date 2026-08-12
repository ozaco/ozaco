import { Codec, hasCodec } from 'std:codec'
import { attempt, createChannel, each, run, scoped, sleep, spawn, withResolvers } from 'std:effect'
import { install } from 'std:plugin'
import type { Result } from 'std:result'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import { fakeCodec } from '../helpers/fake-codec'

const encoder = new TextEncoder()

describe('single-codec routing (exec with one entry)', () => {
  it('protocol-level encode/decode round-trips through the one installed codec', async () => {
    const outcome = await run(() =>
      scoped(function* () {
        yield* install(JsonCodec)

        const payload = { kind: 'greeting', text: 'merhaba dünya', n: 42 }
        const bytes = yield* Codec.actions.encode(payload)
        const back = yield* Codec.actions.decode<typeof payload>(bytes)

        return back
      }),
    )

    expect(unwrap(outcome)).toEqual({ kind: 'greeting', text: 'merhaba dünya', n: 42 })
  })

  it('stringify/parse route the same way', async () => {
    const outcome = await run(() =>
      scoped(function* () {
        yield* install(JsonCodec)

        const text = yield* Codec.actions.stringify([1, 2, 3])
        return yield* Codec.actions.parse<number[]>(text)
      }),
    )

    expect(unwrap(outcome)).toEqual([1, 2, 3])
  })
})

describe('registry scope-locality', () => {
  it('hasCodec/getTransports reflect the current scope chain only', async () => {
    const outcome = await run(function* () {
      const inside = yield* scoped(function* () {
        yield* install(JsonCodec)
        return {
          has: yield* hasCodec(),
          count: (yield* Codec.actions.getTransports()).length,
        }
      })

      const outside = {
        has: yield* hasCodec(),
        count: (yield* Codec.actions.getTransports()).length,
      }

      return { inside, outside }
    })

    expect(unwrap(outcome)).toEqual({
      inside: { has: true, count: 1 },
      outside: { has: false, count: 0 },
    })
  })

  it('registering the same codec name twice fails with `unexpected`', async () => {
    const outcome = await run(() =>
      scoped(function* () {
        yield* install(JsonCodec)
        const second = yield* attempt(() => install(JsonCodec))

        return isFailure(second) ? second.error : 'no-failure'
      }),
    )

    expect(unwrap(outcome)).toBe('unexpected')
  })
})

describe('multi-codec priority routing (Codec.exec)', () => {
  // `Codec.exec` routes by the priority each install's setup returned (`entry.value`). The
  // assertions below pin the routing rules: the highest priority wins, ties break toward the
  // most recently installed codec, and pinned (direct) calls never enter routing at all.

  it('routes protocol calls to the highest-priority codec', async () => {
    const High = fakeCodec('fake-high')

    const outcome = await run(() =>
      scoped(function* () {
        yield* install(JsonCodec) // priority 999
        yield* install(High, { priority: 1500 })

        return yield* Codec.actions.stringify({ n: 1 })
      }),
    )

    expect(unwrap(outcome)).toBe('fake-high:{"n":1}')
  })

  it('breaks priority ties toward the most recently installed codec', async () => {
    const Older = fakeCodec('fake-older')
    const Newer = fakeCodec('fake-newer')

    const outcome = await run(() =>
      scoped(function* () {
        yield* install(Older, { priority: 700 })
        yield* install(Newer, { priority: 700 })

        return yield* Codec.actions.stringify('tie')
      }),
    )

    expect(unwrap(outcome)).toBe('fake-newer:"tie"')
  })

  it('direct (pinned) codec calls bypass priority routing entirely', async () => {
    const High = fakeCodec('fake-high-2')

    const outcome = await run(() =>
      scoped(function* () {
        yield* install(High, { priority: 5000 })
        yield* install(JsonCodec)

        // pinned to the JSON impl — never enters Codec.exec
        return yield* JsonCodec.actions.stringify({ ok: true })
      }),
    )

    expect(unwrap(outcome)).toBe('{"ok":true}')
  })
})

describe('json codec streaming', () => {
  it('decodeFlow reassembles a multi-byte UTF-8 character split across chunks', async () => {
    const outcome = await run(() =>
      scoped(function* () {
        yield* install(JsonCodec)

        const source = createChannel<Uint8Array, true | Result.Failure<unknown>>()
        const decoded = yield* JsonCodec.actions.decodeFlow<string>(source)

        const collected = withResolvers<string[]>()
        yield* spawn(function* () {
          const values: string[] = []
          for (const value of yield* each(decoded)) {
            values.push(value)
            yield* each.next()
          }
          collected.resolve(values)
        })

        // let the decode pipeline subscribe before feeding bytes
        yield* sleep(1)

        const bytes = encoder.encode(JSON.stringify('dünya'))
        // split INSIDE the two-byte 'ü' sequence (0xC3 0xBC)
        const splitAt = bytes.indexOf(0xc3) + 1
        expect(splitAt).toBeGreaterThan(0)

        yield* source.send(bytes.slice(0, splitAt))
        yield* source.send(bytes.slice(splitAt))
        yield* source.close(true)

        return yield* collected.operation
      }),
    )

    expect(unwrap(outcome)).toEqual(['dünya'])
  })

  it('encodeFlow → decodeFlow round-trips a sequence of values', async () => {
    const outcome = await run(() =>
      scoped(function* () {
        yield* install(JsonCodec)

        const source = createChannel<unknown, true | Result.Failure<unknown>>()
        const encoded = yield* JsonCodec.actions.encodeFlow(source)
        const decoded = yield* JsonCodec.actions.decodeFlow(encoded)

        const collected = withResolvers<unknown[]>()
        yield* spawn(function* () {
          const values: unknown[] = []
          for (const value of yield* each(decoded)) {
            values.push(value)
            yield* each.next()
          }
          collected.resolve(values)
        })

        yield* sleep(1)

        yield* source.send({ id: 1 })
        yield* source.send(['a', 'b'])
        yield* source.send('plain')
        yield* source.close(true)

        return yield* collected.operation
      }),
    )

    expect(unwrap(outcome)).toEqual([{ id: 1 }, ['a', 'b'], 'plain'])
  })

  it('a malformed JSON stream surfaces a Failure through the decode channel close', async () => {
    const outcome = await run(() =>
      scoped(function* () {
        yield* install(JsonCodec)

        const source = createChannel<Uint8Array, true | Result.Failure<unknown>>()
        const decoded = yield* JsonCodec.actions.decodeFlow(source)

        const closed = withResolvers<unknown>()
        yield* spawn(function* () {
          const subscription = yield* decoded
          while (true) {
            const next = yield* subscription.next()
            if (next.done) {
              closed.resolve(next.value)
              return
            }
          }
        })

        yield* sleep(1)

        yield* source.send(encoder.encode('{"broken":'))
        yield* source.send(encoder.encode('not-json}}}'))
        yield* source.close(true)

        const closeValue = yield* closed.operation
        return closeValue === true ? 'clean-close' : isFailure(closeValue) ? 'failure' : 'other'
      }),
    )

    expect(unwrap(outcome)).toBe('failure')
  })
})
