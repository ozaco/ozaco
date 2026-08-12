import { run } from 'std:effect'
import { DefaultLogger, Logger, LogLevel } from 'std:logger'
import { install } from 'std:plugin'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { captureTransport, createSink } from './helpers'

describe('logger creation + record shape', () => {
  it('delivers a fully-shaped entry to the installed transport', async () => {
    const sink = createSink()

    unwrap(
      await run(function* () {
        yield* install(DefaultLogger, { timestamp: () => 1111 })
        yield* install(captureTransport('capture', sink))

        yield* Logger.actions.info('hello', 'world', { a: 1 })
      }),
    )

    expect(sink.entries).toHaveLength(1)
    expect(sink.entries[0]).toEqual({
      level: LogLevel.info,
      time: 1111,
      msg: 'hello world',
      error: '',
      bindings: {},
      data: { a: 1 },
    })
  })

  it('logging without an installed logger fails with missing-action', async () => {
    const outcome = await run(function* () {
      yield* Logger.actions.info('nobody home')
    })

    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('missing-action')
    }
  })

  it('logging with a logger but zero transports is a successful no-op', async () => {
    const outcome = await run(function* () {
      yield* install(DefaultLogger)
      yield* Logger.actions.info('into the void')
      return 'done'
    })

    expect(unwrap(outcome)).toBe('done')
  })
})

describe('level thresholds', () => {
  it('filters below the default info threshold', async () => {
    const sink = createSink()

    unwrap(
      await run(function* () {
        yield* install(DefaultLogger)
        yield* install(captureTransport('capture', sink))

        yield* Logger.actions.trace('t')
        yield* Logger.actions.debug('d')
        yield* Logger.actions.info('i')
        yield* Logger.actions.warn('w')
        yield* Logger.actions.error('e')
        yield* Logger.actions.fatal('f')
      }),
    )

    expect(sink.entries.map(entry => entry.level)).toEqual([
      LogLevel.info,
      LogLevel.warn,
      LogLevel.error,
      LogLevel.fatal,
    ])
  })

  it('options.level raises the threshold; silent suppresses everything', async () => {
    const errorOnly = createSink()

    unwrap(
      await run(function* () {
        yield* install(DefaultLogger, { level: LogLevel.error })
        yield* install(captureTransport('capture', errorOnly))

        yield* Logger.actions.info('dropped')
        yield* Logger.actions.warn('dropped')
        yield* Logger.actions.error('kept')
        yield* Logger.actions.fatal('kept')
      }),
    )

    expect(errorOnly.entries.map(entry => entry.level)).toEqual([LogLevel.error, LogLevel.fatal])

    const silenced = createSink()

    unwrap(
      await run(function* () {
        yield* install(DefaultLogger, { level: LogLevel.silent })
        yield* install(captureTransport('capture', silenced))

        yield* Logger.actions.fatal('still dropped')
      }),
    )

    expect(silenced.entries).toEqual([])
  })

  it('setLevel and isLevelEnabled track the runtime threshold', async () => {
    const sink = createSink()

    const outcome = await run(function* () {
      yield* install(DefaultLogger, { level: LogLevel.warn })
      yield* install(captureTransport('capture', sink))

      const before = {
        trace: yield* Logger.actions.isLevelEnabled(LogLevel.trace),
        warn: yield* Logger.actions.isLevelEnabled(LogLevel.warn),
        fatal: yield* Logger.actions.isLevelEnabled(LogLevel.fatal),
      }

      yield* Logger.actions.debug('dropped')
      yield* Logger.actions.setLevel(LogLevel.debug)
      yield* Logger.actions.debug('kept')

      // debug is now enabled, trace still is not
      const after = {
        trace: yield* Logger.actions.isLevelEnabled(LogLevel.trace),
        debug: yield* Logger.actions.isLevelEnabled(LogLevel.debug),
      }

      return { before, after }
    })

    expect(unwrap(outcome)).toEqual({
      before: { trace: false, warn: true, fatal: true },
      after: { trace: false, debug: true },
    })
    expect(sink.entries.map(entry => entry.msg)).toEqual(['kept'])
  })

  it('log(level, ...) dispatches exactly like the level helpers', async () => {
    const sink = createSink()

    unwrap(
      await run(function* () {
        yield* install(DefaultLogger)
        yield* install(captureTransport('capture', sink))

        yield* Logger.actions.log(LogLevel.warn, 'via-log', { n: 1 })
        yield* Logger.actions.log(LogLevel.debug, 'below threshold')
      }),
    )

    expect(sink.entries).toHaveLength(1)
    expect(sink.entries[0]).toMatchObject({ level: LogLevel.warn, msg: 'via-log', data: { n: 1 } })
  })
})
