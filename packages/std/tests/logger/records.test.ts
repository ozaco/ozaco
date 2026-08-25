import { run } from 'std:effect'
import { DefaultLogger, Logger } from 'std:logger'
import { install } from 'std:plugin'
import { fail, succeed, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { captureTransport, createSink } from './helpers'

describe('payload normalization', () => {
  it('joins string args with spaces and skips null/undefined', async () => {
    const sink = createSink()

    unwrap(
      await run(function* () {
        yield* install(DefaultLogger)
        yield* install(captureTransport('capture', sink))

        yield* Logger.actions.info('one', null, 'two', undefined, 'three')
      }),
    )

    expect(sink.entries[0]).toMatchObject({ msg: 'one two three', error: '' })
    expect(sink.entries[0]?.data).toBeUndefined()
  })

  it('merges object args into data; later keys win', async () => {
    const sink = createSink()

    unwrap(
      await run(function* () {
        yield* install(DefaultLogger)
        yield* install(captureTransport('capture', sink))

        yield* Logger.actions.info({ a: 1, shared: 'first' }, 'between', { b: 2, shared: 'second' })
      }),
    )

    expect(sink.entries[0]?.msg).toBe('between')
    expect(sink.entries[0]?.data).toEqual({ a: 1, b: 2, shared: 'second' })
  })

  it('a failure payload becomes the entry error string', async () => {
    const sink = createSink()

    unwrap(
      await run(function* () {
        yield* install(DefaultLogger)
        yield* install(captureTransport('capture', sink))

        yield* Logger.actions.error('request failed', fail('boom', 'it broke', 'c-1', 'c-2'))
        yield* Logger.actions.error(fail('bare'))
      }),
    )

    expect(sink.entries.map(entry => ({ msg: entry.msg, error: entry.error }))).toEqual([
      { msg: 'request failed', error: 'boom: it broke: c-1 > c-2' },
      { msg: '', error: 'bare' },
    ])
  })

  it('a failure payload does not leak its internals into entry.data', async () => {
    const sink = createSink()

    unwrap(
      await run(function* () {
        yield* install(DefaultLogger)
        yield* install(captureTransport('capture', sink))

        yield* Logger.actions.error(fail('boom', 'why'))
      }),
    )

    expect(sink.entries[0]?.data).toBeUndefined()
  })

  it('success results are unwrapped and normalized like plain payloads', async () => {
    const sink = createSink()

    unwrap(
      await run(function* () {
        yield* install(DefaultLogger)
        yield* install(captureTransport('capture', sink))

        yield* Logger.actions.info(succeed('unwrapped'), succeed({ n: 7 }))
      }),
    )

    expect(sink.entries[0]?.msg).toBe('unwrapped')
    expect(sink.entries[0]?.data).toEqual({ n: 7 })
  })
})

describe('bindings', () => {
  it('setup bindings stamp every entry; bind() merges more', async () => {
    const sink = createSink()

    unwrap(
      await run(function* () {
        yield* install(DefaultLogger, { bindings: { app: 'std' } })
        yield* install(captureTransport('capture', sink))

        yield* Logger.actions.info('first')
        yield* Logger.actions.bind({ req: 'r-1' })
        yield* Logger.actions.info('second')
      }),
    )

    expect(sink.entries.map(entry => entry.bindings)).toEqual([
      { app: 'std' },
      { app: 'std', req: 'r-1' },
    ])
  })

  it('child() scopes extra bindings to the callback and restores after', async () => {
    const sink = createSink()

    const outcome = await run(function* () {
      yield* install(DefaultLogger)
      yield* install(captureTransport('capture', sink))

      const value = yield* Logger.actions.child({ traceId: 't-1' }, function* () {
        yield* Logger.actions.info('inside')
        return 'from-child'
      })

      yield* Logger.actions.info('outside')

      return value
    })

    expect(unwrap(outcome)).toBe('from-child')
    expect(sink.entries.map(entry => entry.bindings)).toEqual([{ traceId: 't-1' }, {}])
  })
})
