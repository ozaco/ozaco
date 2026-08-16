import { boundLogger, moduleLogger } from 'server:utils'
import { useContext } from 'std:effect'
import type { LoggerDef } from 'std:logger'
import { DefaultLogger, LoggerTransport, LogLevel } from 'std:logger'
import { install } from 'std:plugin'

import { describe, expect, it } from 'bun:test'

import { runScoped } from '../helpers'

interface CaptureContext {
  name: string
  level: LogLevel
  entries: LoggerDef.Entry[]
}

/** An in-memory LoggerTransport impl that captures dispatched entries for assertions. */
const captureTransport = (entries: LoggerDef.Entry[]) => {
  const impl = LoggerTransport.implement<CaptureContext, []>({
    name: 'capture',
    version: '0.0.0',
    *setup() {
      return { name: 'capture', level: LogLevel.trace, entries }
    },
  })

  return impl.build({
    *write(entry) {
      const ctx = yield* useContext(impl.context)
      ctx.entries.push(entry)
    },
    *flush() {},
    *close() {},
  })
}

describe('boundLogger', () => {
  it('logs through the installed logger with its bindings attached', async () => {
    const entries: LoggerDef.Entry[] = []

    await runScoped(function* () {
      yield* install(DefaultLogger, { level: LogLevel.trace, timestamp: () => 42 })
      yield* install(captureTransport(entries))

      const logger = yield* boundLogger({ service: 'gateway' })
      yield* logger.info('ready', { port: 8080 })
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]!.msg).toBe('ready')
    expect(entries[0]!.level).toBe(LogLevel.info)
    expect(entries[0]!.time).toBe(42)
    expect(entries[0]!.bindings).toEqual({ service: 'gateway' })
    expect(entries[0]!.data).toEqual({ port: 8080 })
  })

  it('dispatches every level at its own severity', async () => {
    const entries: LoggerDef.Entry[] = []

    await runScoped(function* () {
      yield* install(DefaultLogger, { level: LogLevel.trace })
      yield* install(captureTransport(entries))

      const logger = yield* boundLogger()
      yield* logger.trace('t')
      yield* logger.debug('d')
      yield* logger.info('i')
      yield* logger.warn('w')
      yield* logger.error('e')
      yield* logger.fatal('f')
    })

    expect(entries.map(entry => entry.level)).toEqual([
      LogLevel.trace,
      LogLevel.debug,
      LogLevel.info,
      LogLevel.warn,
      LogLevel.error,
      LogLevel.fatal,
    ])
  })

  it('child merges extra bindings on top of the parent', async () => {
    const entries: LoggerDef.Entry[] = []

    await runScoped(function* () {
      yield* install(DefaultLogger, { level: LogLevel.trace })
      yield* install(captureTransport(entries))

      const logger = yield* boundLogger({ service: 'gateway' })
      const child = logger.child({ request: 'r_1' })

      expect(child.bindings).toEqual({ service: 'gateway', request: 'r_1' })
      yield* child.warn('slow')
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]!.bindings).toEqual({ service: 'gateway', request: 'r_1' })
  })

  it('moduleLogger pins the module binding', async () => {
    const entries: LoggerDef.Entry[] = []

    await runScoped(function* () {
      yield* install(DefaultLogger, { level: LogLevel.trace })
      yield* install(captureTransport(entries))

      const logger = yield* moduleLogger('core', { region: 'eu' })
      yield* logger.debug('booted')
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]!.bindings).toEqual({ module: 'core', region: 'eu' })
  })

  it('falls back to a silent no-op when no Logger impl is installed', async () => {
    const result = await runScoped(function* () {
      const logger = yield* boundLogger({ service: 'ghost' })
      yield* logger.error('nobody hears this')

      const child = logger.child({ more: true })
      yield* child.info('still nothing')

      expect(logger.bindings).toEqual({ service: 'ghost' })
      expect(child.bindings).toEqual({ service: 'ghost', more: true })

      return 'ok'
    })

    expect(result).toBe('ok')
  })
})
