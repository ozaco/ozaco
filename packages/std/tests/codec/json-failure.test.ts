/**
 * JsonCodec carries failures: a Failure (anywhere in the value) is written as a tagged object
 * `{ _t: 'std:result:failure', error, message, causes }`, recursively through the causes; decoding
 * rebuilds real Failures (`isFailure`, `yield*`-able). `_d` and `raw` (a fold's foreign value)
 * never travel, and no native `Error` is written or rebuilt — JSON renders one as `{}`. Every
 * JsonCodec path does it: encode / decode, stringify / parse, encodeFlow / decodeFlow. A Failure
 * decoded as the WHOLE value is what the action returns — and a returned Failure is raised (std's
 * plugin contract): `attempt` hands it back as a value; a failure inside a value (an envelope
 * field, a list item) is just data.
 */
import type { Flow, Operation } from 'std:effect'
import { attempt, each, flowOf, run } from 'std:effect'
import type { Result } from 'std:result'
import { ResultErrors, asFailure, fail, formatFailure, isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'

import pkg from '../../package.json'

/** Run `body` with JsonCodec installed; the body's value. */
const withJson = async <T>(body: () => Operation<T>): Promise<T> =>
  unwrap(
    await run(function* () {
      yield* JsonCodec.use()
      return yield* body()
    }),
  )

/** Through bytes and back (`encode` then `decode`), inside an envelope. */
const roundTrip = async <T>(value: T): Promise<T> => {
  const { payload } = await withJson(function* () {
    const bytes = yield* JsonCodec.actions.encode({ payload: value })
    return yield* JsonCodec.actions.decode<{ payload: T }>(bytes)
  })
  return payload
}

const nestedAt = (failure: Result.Failure<unknown>, index: number): Result.Failure<unknown> => {
  const cause = failure.causes[index]
  if (!isFailure(cause)) {
    throw new Error(`cause ${index} is not a failure`)
  }
  return cause
}

/** A 3-level chain: a tag over a tag over the fold of a thrown TypeError. */
const threeLevels = () => {
  const error = new TypeError('x is not a function')
  const mid = fail('todos.db-step', 'db step broke', 'reading row', asFailure(error))
  const outer = fail('todo.kaput', 'boom', 'todos.explode', mid)

  return { error, mid, outer }
}

describe('JsonCodec — failures', () => {
  it('round-trips a 3-level chain: tags, messages and causes — the fold without its raw', async () => {
    const { outer } = threeLevels()

    const decoded = await roundTrip(outer)

    expect(isFailure(decoded)).toBe(true)
    expect(decoded.error).toBe('todo.kaput')
    expect(decoded.message).toBe('boom')
    expect(decoded.causes[0]).toBe('todos.explode')

    const mid = nestedAt(decoded, 1)
    expect(mid.error).toBe('todos.db-step')
    expect(mid.causes[0]).toBe('reading row')

    const fold = nestedAt(mid, 1)
    expect(fold.error).toBe(ResultErrors.Unknown)
    expect(fold.message).toBe('TypeError: x is not a function')
    expect('raw' in fold).toBe(false)

    // the rendering is the sender's
    expect(formatFailure(decoded, { chain: true })).toBe(formatFailure(outer, { chain: true }))
    expect(formatFailure(decoded)).toBe(formatFailure(outer))
  })

  it('a decoded failure is a real Failure: isFailure, and `yield*` raises it', async () => {
    const decoded = await roundTrip(fail('todo.kaput', 'boom'))

    expect(isFailure(decoded)).toBe(true)
    expect([...decoded]).toEqual([decoded])

    const raised = await run(function* () {
      return yield* decoded
    })
    expect(raised).toBe(decoded)
  })

  it('a Failure decoded as the whole value is raised by the action; attempt returns it', async () => {
    const outcome = await run(function* () {
      yield* JsonCodec.use()
      const bytes = yield* JsonCodec.actions.encode(fail('todo.kaput', 'boom', 'x'))

      return {
        attempted: yield* attempt(() => JsonCodec.actions.decode(bytes)),
        parsed: yield* attempt(() => JsonCodec.actions.parse(new TextDecoder().decode(bytes))),
      }
    })

    const { attempted, parsed } = unwrap(outcome)
    for (const [decoded, action] of [
      [attempted, 'decode'],
      [parsed, 'parse'],
    ] as const) {
      expect(isFailure(decoded)).toBe(true)
      // the sender's causes, then the plugin runtime labels of the hops it was raised through
      expect(decoded).toMatchObject({
        error: 'todo.kaput',
        message: 'boom',
        causes: [
          'x',
          action,
          `std/json-codec@${pkg.version}`,
          'dispatch',
          `std/codec@${pkg.version}`,
        ],
      })
    }
  })

  it('writes the tagged form, `_d` and `raw` left behind', async () => {
    const text = await withJson(function* () {
      return yield* JsonCodec.actions.stringify(
        fail('tag', 'msg', 'cause', asFailure(new RangeError('far'))),
      )
    })
    const data: unknown = JSON.parse(text)

    expect(data).toEqual({
      _t: 'std:result:failure',
      error: 'tag',
      message: 'msg',
      causes: [
        'cause',
        {
          _t: 'std:result:failure',
          error: ResultErrors.Unknown,
          message: 'RangeError: far',
          causes: [],
        },
      ],
    })
  })

  it('round-trips a bare fail(), an object error, and failures inside plain data', async () => {
    const bare = await roundTrip(fail())
    expect(isFailure(bare) && bare.error).toBeUndefined()

    const object = await roundTrip(fail({ reason: 'bad' }, 'msg'))
    expect(object.error).toEqual({ reason: 'bad' })

    const data = await roundTrip({
      list: [fail('a'), new SyntaxError('b')],
      nested: { failure: fail('c', 'm', 'x') },
      plain: { _t: 'user-data', n: 1 },
    })

    expect(isFailure(data.list[0])).toBe(true)
    // a native Error is plain JSON: `{}`, never rebuilt
    expect(data.list[1] as unknown).toEqual({})
    expect(isFailure(data.nested.failure) && data.nested.failure.causes).toEqual(['x'])
    expect(data.plain).toEqual({ _t: 'user-data', n: 1 })
  })

  it('writes plain values exactly as JSON.stringify does', async () => {
    const value = { a: [1, 'two', { three: null }], b: true, c: new Date(0), d: undefined }

    const text = await withJson(function* () {
      return yield* JsonCodec.actions.stringify(value, 2)
    })

    expect(text).toBe(JSON.stringify(value, null, 2))
  })

  it('cuts a cause cycle where it closes instead of failing', async () => {
    const first = fail('first')
    const second = fail('second', '', first)
    first.causes.push(second)

    const decoded = await roundTrip(second)
    const inner = nestedAt(decoded, 0)

    expect(inner.error).toBe('first')
    expect(inner.causes).toEqual([])
  })

  it('keeps only well-typed fields of junk tagged data', async () => {
    const decoded = await withJson(function* () {
      return yield* JsonCodec.actions.parse<unknown[]>(
        JSON.stringify([
          { _t: 'std:result:failure' },
          { _t: 'std:result:failure', error: 'tag', message: 7, causes: ['ok', 3, { x: 1 }] },
          { _t: 'std:error', name: 'TypeError', message: 'm' },
        ]),
      )
    })

    const [empty, typed, error] = decoded as [
      Result.Failure<unknown>,
      Result.Failure<unknown>,
      unknown,
    ]
    expect(isFailure(empty) && empty.error).toBeUndefined()
    expect(typed.message).toBe('')
    expect(typed.causes).toEqual(['ok'])
    // nothing rebuilds a native Error: an old `std:error` tag is plain data
    expect(error).toEqual({ _t: 'std:error', name: 'TypeError', message: 'm' })
  })

  it('encodeFlow / decodeFlow carry failures too', async () => {
    const values = await withJson(function* () {
      const source = flowOf<unknown>(function* (emit) {
        yield* emit(fail('flow.kaput', 'boom', fail('flow.inner', 'inner')))
        yield* emit({ ok: 1 })
      })
      const encoded = yield* JsonCodec.actions.encodeFlow(source)
      const decoded = yield* JsonCodec.actions.decodeFlow(encoded as Flow<Uint8Array, unknown>)
      const out: unknown[] = []

      for (const value of yield* each(decoded)) {
        out.push(value)
        yield* each.next()
      }

      return out
    })

    expect(isFailure(values[0])).toBe(true)
    const failure = values[0] as Result.Failure<unknown>
    expect(nestedAt(failure, 0).error).toBe('flow.inner')
    expect(values[1]).toEqual({ ok: 1 })
  })

  it('a codec failure still surfaces as one (a value JSON cannot write)', async () => {
    const outcome = await run(function* () {
      yield* JsonCodec.use()
      return yield* JsonCodec.actions.encode({ big: 1n })
    })

    expect(isFailure(outcome) && outcome.error).toBe('std:codec.encode')
  })
})
