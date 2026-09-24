import { Codec } from 'std:codec'
import {
  attempt,
  createChannel,
  each,
  run,
  scoped,
  sleep,
  spawn,
  useContext,
  withResolvers,
} from 'std:effect'
import { PluginErrors } from 'std:plugin'
import type { Result } from 'std:result'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'
import { TomlCodec } from 'std:codec/impl/toml'

import { fakeCodec } from '../helpers/fake-codec'

const encoder = new TextEncoder()

describe('single-codec routing (exec with one entry)', () => {
  it('protocol-level encode/decode round-trips through the one installed codec', async () => {
    const outcome = await run(function* () {
      yield* JsonCodec.use()

      const payload = { kind: 'greeting', text: 'hello world — café', n: 42 }
      const bytes = yield* Codec.actions.encode(payload)
      const back = yield* Codec.actions.decode<typeof payload>(bytes)

      return back
    })

    expect(unwrap(outcome)).toEqual({ kind: 'greeting', text: 'hello world — café', n: 42 })
  })

  it('stringify/parse route the same way', async () => {
    const outcome = await run(function* () {
      yield* JsonCodec.use()

      const text = yield* Codec.actions.stringify([1, 2, 3])
      return yield* Codec.actions.parse<number[]>(text)
    })

    expect(unwrap(outcome)).toEqual([1, 2, 3])
  })
})

describe('registry scope-locality', () => {
  it('hasCodec/getTransports reflect the current scope chain only', async () => {
    const outcome = await run(function* () {
      const inside = yield* scoped(function* () {
        yield* JsonCodec.use()
        return {
          has: yield* Codec.actions.hasCodec(),
          count: (yield* Codec.actions.getTransports()).length,
        }
      })

      const outside = {
        has: yield* Codec.actions.hasCodec(),
        count: (yield* Codec.actions.getTransports()).length,
      }

      return { inside, outside }
    })

    expect(unwrap(outcome)).toEqual({
      inside: { has: true, count: 1 },
      outside: { has: false, count: 0 },
    })
  })

  it('re-installing the SAME codec (same name) is an idempotent no-op — one registry entry', async () => {
    const outcome = await run(function* () {
      yield* JsonCodec.use()
      const second = yield* attempt(() => JsonCodec.use())

      return {
        ok: !isFailure(second),
        count: (yield* Codec.actions.getTransports()).length,
      }
    })

    expect(unwrap(outcome)).toEqual({ ok: true, count: 1 })
  })

  it('a child scope may re-install the codec its parent registered', async () => {
    const outcome = await run(function* () {
      yield* JsonCodec.use()

      const inner = yield* scoped(function* () {
        const again = yield* attempt(() => JsonCodec.use())
        return {
          ok: !isFailure(again),
          count: (yield* Codec.actions.getTransports()).length,
          encoded: yield* Codec.actions.stringify({ a: 1 }),
        }
      })

      // the parent's registration is untouched by the child's install + teardown
      return { inner, outerCount: (yield* Codec.actions.getTransports()).length }
    })

    expect(unwrap(outcome)).toEqual({
      inner: { ok: true, count: 1, encoded: '{"a":1}' },
      outerCount: 1,
    })
  })

  it('a DIFFERENT codec claiming a registered name fails `CodecErrors.AlreadyRegistered`', async () => {
    const outcome = await run(function* () {
      yield* JsonCodec.use()
      const clash = yield* attempt(() => TomlCodec.use({ name: 'std/json-codec' }))

      return isFailure(clash) ? clash.error : 'no-failure'
    })

    expect(unwrap(outcome)).toBe('std:codec.already-registered')
  })
  it('one impl installed under two names lands in the registry twice (keyed by name)', async () => {
    const outcome = await run(function* () {
      yield* JsonCodec.use({ name: 'json-a' })
      yield* JsonCodec.use({ name: 'json-b' })

      const listed = yield* Codec.actions.getTransports()
      const names: string[] = []
      for (const codec of listed) {
        names.push((yield* useContext(codec)).name)
      }

      // ONE install is active (the second replaced the first), the registry still counts two —
      // and both entries resolve the latest install's context
      return { count: listed.length, samePlugin: listed[0] === listed[1], names }
    })

    expect(unwrap(outcome)).toEqual({
      count: 2,
      samePlugin: true,
      names: ['json-b', 'json-b'],
    })
  })

  it('an impl that never calls `register` is routable yet invisible to the registry', async () => {
    const outcome = await run(function* () {
      // the fake codec's setup builds a context only — routing reads the install list, the
      // registry handlers read what `register` wrote
      yield* fakeCodec('solo').use()

      return {
        routed: yield* Codec.actions.stringify({ a: 1 }),
        has: yield* Codec.actions.hasCodec(),
        count: (yield* Codec.actions.getTransports()).length,
      }
    })

    expect(unwrap(outcome)).toEqual({ routed: 'solo:{"a":1}', has: false, count: 0 })
  })

  it('a protocol call with no codec installed fails `PluginErrors.MissingAction`', async () => {
    const outcome = await run(function* () {
      const result = yield* attempt(() => Codec.actions.stringify({ a: 1 }))

      return isFailure(result) ? result.error : 'no-failure'
    })

    expect(unwrap(outcome)).toBe(PluginErrors.MissingAction)
  })
})

describe('multi-codec priority routing (Codec.exec)', () => {
  // `Codec.exec` routes by the priority each install's setup returned (`entry.value`). The
  // assertions below pin the routing rules: the highest priority wins, ties break toward the
  // most recently installed codec, and pinned (direct) calls never enter routing at all.

  it('routes protocol calls to the highest-priority codec', async () => {
    const High = fakeCodec('fake-high')

    const outcome = await run(function* () {
      yield* JsonCodec.use() // priority 999
      yield* High.use({ priority: 1500 })

      return yield* Codec.actions.stringify({ n: 1 })
    })

    expect(unwrap(outcome)).toBe('fake-high:{"n":1}')
  })

  it('getTransports lists the registry ascending by priority — the active codec is last', async () => {
    const outcome = await run(function* () {
      const Low = fakeCodec('order-low')
      const High = fakeCodec('order-high')
      yield* High.use({ priority: 900 })
      yield* Low.use({ priority: 100 })
      yield* Codec.actions.register(High, { name: 'order-high', priority: 900, ext: 'fake' })
      yield* Codec.actions.register(Low, { name: 'order-low', priority: 100, ext: 'fake' })

      return (yield* Codec.actions.getTransports()).map(codec => codec.name)
    })

    expect(unwrap(outcome)).toEqual(['order-low', 'order-high'])
  })

  it('breaks priority ties toward the most recently installed codec', async () => {
    const Older = fakeCodec('fake-older')
    const Newer = fakeCodec('fake-newer')

    const outcome = await run(function* () {
      yield* Older.use({ priority: 700 })
      yield* Newer.use({ priority: 700 })

      return yield* Codec.actions.stringify('tie')
    })

    expect(unwrap(outcome)).toBe('fake-newer:"tie"')
  })

  it('direct (pinned) codec calls bypass priority routing entirely', async () => {
    const High = fakeCodec('fake-high-2')

    const outcome = await run(function* () {
      yield* High.use({ priority: 5000 })
      yield* JsonCodec.use()

      // pinned to the JSON impl — never enters Codec.exec
      return yield* JsonCodec.actions.stringify({ ok: true })
    })

    expect(unwrap(outcome)).toBe('{"ok":true}')
  })
})

describe('json codec streaming', () => {
  it('decodeFlow reassembles a multi-byte UTF-8 character split across chunks', async () => {
    const outcome = await run(function* () {
      yield* JsonCodec.use()

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

      const bytes = encoder.encode(JSON.stringify('café'))
      // split INSIDE the two-byte 'é' sequence (0xC3 0xA9)
      const splitAt = bytes.indexOf(0xc3) + 1
      expect(splitAt).toBeGreaterThan(0)

      yield* source.send(bytes.slice(0, splitAt))
      yield* source.send(bytes.slice(splitAt))
      yield* source.close(true)

      return yield* collected.operation
    })

    expect(unwrap(outcome)).toEqual(['café'])
  })

  it('encodeFlow → decodeFlow round-trips a sequence of values', async () => {
    const outcome = await run(function* () {
      yield* JsonCodec.use()

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
    })

    expect(unwrap(outcome)).toEqual([{ id: 1 }, ['a', 'b'], 'plain'])
  })

  it('a malformed JSON stream surfaces a Failure through the decode channel close', async () => {
    const outcome = await run(function* () {
      yield* JsonCodec.use()

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
    })

    expect(unwrap(outcome)).toBe('failure')
  })
})
