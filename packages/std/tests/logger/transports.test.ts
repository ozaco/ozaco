import type { Operation } from 'std:effect'
import { run, scoped } from 'std:effect'
import type { LoggerDef } from 'std:logger'
import { DefaultLogger, Logger, LoggerTransport, LogLevel } from 'std:logger'
import { fail, isFailure, unwrap } from 'std:result'

import { describe, expect, it, spyOn } from 'bun:test'

import { JsonCodec } from 'std:codec/impl/json'
import { ConsoleTransport } from 'std:logger/transport/console'

import { captureTransport, createSink } from './helpers'

/** Deterministic console format — avoids timestamps, colors, and the JSON codec. */
const plainFormat = function* (entry: LoggerDef.Entry): Operation<string> {
  return `fmt:${entry.msg}`
}

const failingTransport = (name: string) =>
  LoggerTransport.implement<{ name: string; level: LogLevel }, []>({
    name,
    version: '1.0.0',
    *setup() {
      return { name, level: LogLevel.trace }
    },
  }).build({
    *write() {
      return yield* fail('transport-boom', 'sink unavailable')
    },
    *flush() {},
    *close() {},
  })

describe('transport fan-out', () => {
  it('write fans out to every installed transport', async () => {
    const first = createSink()
    const second = createSink()

    unwrap(
      await run(function* () {
        yield* DefaultLogger.use({ timestamp: () => 5 })
        yield* captureTransport('capture-a', first).use()
        yield* captureTransport('capture-b', second).use()

        yield* Logger.actions.info('broadcast')
      }),
    )

    expect(first.entries).toHaveLength(1)
    expect(second.entries).toHaveLength(1)
    expect(first.entries[0]).toEqual(second.entries[0]!)
  })

  it('each transport applies its own level threshold', async () => {
    const loose = createSink()
    const strict = createSink()

    unwrap(
      await run(function* () {
        yield* DefaultLogger.use()
        yield* captureTransport('capture-loose', loose).use()
        yield* captureTransport('capture-strict', strict, LogLevel.warn).use()

        yield* Logger.actions.info('info-only')
        yield* Logger.actions.warn('warned')
      }),
    )

    expect(loose.entries.map(entry => entry.msg)).toEqual(['info-only', 'warned'])
    expect(strict.entries.map(entry => entry.msg)).toEqual(['warned'])
  })

  it('reinstalling the same transport tag replaces it instead of duplicating', async () => {
    const stale = createSink()
    const active = createSink()

    unwrap(
      await run(function* () {
        yield* DefaultLogger.use()
        yield* captureTransport('capture-dup', stale).use()
        yield* captureTransport('capture-dup', active).use()

        yield* Logger.actions.info('once')
      }),
    )

    expect(stale.entries).toHaveLength(0)
    expect(active.entries).toHaveLength(1)
  })

  it('flush and close forward to every transport', async () => {
    const first = createSink()
    const second = createSink()

    unwrap(
      await run(function* () {
        yield* DefaultLogger.use()
        yield* captureTransport('capture-a', first).use()
        yield* captureTransport('capture-b', second).use()

        yield* Logger.actions.flush()
        yield* Logger.actions.close()
      }),
    )

    expect([first.flushes, first.closes]).toEqual([1, 1])
    expect([second.flushes, second.closes]).toEqual([1, 1])
  })

  it('a failing transport write propagates as the log call failure', async () => {
    const outcome = await run(function* () {
      yield* DefaultLogger.use()
      yield* failingTransport('capture-broken').use()

      yield* Logger.actions.info('will not land')
    })

    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('transport-boom')
    }
  })

  it('transport installs are scope-local: gone after the scope closes', async () => {
    const sink = createSink()

    const outcome = await run(function* () {
      yield* DefaultLogger.use()

      yield* scoped(function* () {
        yield* captureTransport('capture-scoped', sink).use()
        yield* Logger.actions.info('inside')
      })

      // the scoped transport is gone — this dispatches to zero transports and stays a no-op
      yield* Logger.actions.info('outside')

      return sink.entries.map(entry => entry.msg)
    })

    expect(unwrap(outcome)).toEqual(['inside'])
  })
})

describe('console transport', () => {
  it('routes levels to the matching console methods', async () => {
    const debugSpy = spyOn(console, 'debug').mockImplementation(() => {})
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {})
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})

    try {
      unwrap(
        await run(function* () {
          yield* DefaultLogger.use({ level: LogLevel.trace })
          yield* ConsoleTransport.use({ format: plainFormat })

          yield* Logger.actions.trace('t')
          yield* Logger.actions.debug('d')
          yield* Logger.actions.info('i')
          yield* Logger.actions.warn('w')
          yield* Logger.actions.error('e')
          yield* Logger.actions.fatal('f')
        }),
      )

      expect(debugSpy.mock.calls.map(call => call[0])).toEqual(['fmt:t', 'fmt:d'])
      expect(infoSpy.mock.calls.map(call => call[0])).toEqual(['fmt:i'])
      expect(warnSpy.mock.calls.map(call => call[0])).toEqual(['fmt:w'])
      expect(errorSpy.mock.calls.map(call => call[0])).toEqual(['fmt:e', 'fmt:f'])
    } finally {
      debugSpy.mockRestore()
      infoSpy.mockRestore()
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it('pretty:false emits JSON records honoring msgKey/errorKey', async () => {
    const infoSpy = spyOn(console, 'info').mockImplementation(() => {})
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})

    try {
      unwrap(
        await run(function* () {
          yield* JsonCodec.use()
          yield* DefaultLogger.use({ timestamp: () => 1111 })
          yield* ConsoleTransport.use({ pretty: false, msgKey: 'note', errorKey: 'problem' })

          yield* Logger.actions.info('hi', { n: 1 })
          yield* Logger.actions.error('bad', fail('boom', 'why'))
        }),
      )

      expect(JSON.parse(infoSpy.mock.calls[0]?.[0] as string)).toEqual({
        level: LogLevel.info,
        time: 1111,
        note: 'hi',
        n: 1,
      })
      expect(JSON.parse(errorSpy.mock.calls[0]?.[0] as string)).toMatchObject({
        level: LogLevel.error,
        time: 1111,
        note: 'bad',
        problem: 'boom: why',
      })
    } finally {
      infoSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })
})

describe('console transport install order', () => {
  it('installing ConsoleTransport BEFORE the logger fails: setup needs the Logger context', async () => {
    // `ConsoleTransport.setup` does `useContext(Logger)` to inherit the logger level, so the logger
    // must already be installed in the scope (documented on the setup docblock, AUDIT L5)
    const outcome = await run(function* () {
      yield* JsonCodec.use()
      yield* ConsoleTransport.use({ format: plainFormat })
      yield* DefaultLogger.use()
      return 'unreachable'
    })

    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('std:effect.missing-context')
    }
  })

  it('installing ConsoleTransport AFTER the logger succeeds and inherits its level', async () => {
    const outcome = await run(function* () {
      yield* JsonCodec.use()
      yield* DefaultLogger.use({ level: LogLevel.warn })
      const ctx = yield* ConsoleTransport.use({ format: plainFormat })
      return ctx.level
    })

    expect(unwrap(outcome)).toBe(LogLevel.warn)
  })
})
