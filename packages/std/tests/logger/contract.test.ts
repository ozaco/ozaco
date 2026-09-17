/**
 * Logger contract details: `log(level, …)` is the same call as the level shorthands, the file
 * transport's `ensureDir` decides whether missing directories are created, and an array payload
 * is a value in the message — never index keys in `data`.
 */
import { attempt, run } from 'std:effect'
import { IO } from 'std:io'
import { DefaultLogger, Logger, LoggerErrors, LogLevel } from 'std:logger'
import { isFailure, unwrap } from 'std:result'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { JsonCodec } from 'std:codec/impl/json'
import { BunIO } from 'std:io/impl/bun'
import { FileTransport } from 'std:logger/transport/file'

import { normalizePayload } from '../../src/logger/internal/normalize'

import { captureTransport, createSink } from './helpers'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ozaco-logger-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('logger — contract', () => {
  it('log(level, …) dispatches exactly like the shorthand and honours the logger level', async () => {
    const sink = createSink()

    unwrap(
      await run(function* () {
        yield* DefaultLogger.use({ level: LogLevel.info, timestamp: () => 7 })
        yield* captureTransport('capture', sink).use()

        yield* Logger.actions.log(LogLevel.warn, 'explicit', { n: 1 })
        yield* Logger.actions.warn('shorthand', { n: 1 })
        yield* Logger.actions.log(LogLevel.debug, 'filtered')
      }),
    )

    expect(sink.entries.map(entry => [entry.level, entry.msg, entry.data])).toEqual([
      [LogLevel.warn, 'explicit', { n: 1 }],
      [LogLevel.warn, 'shorthand', { n: 1 }],
    ])
  })

  it('file transport: ensureDir creates the parents; ensureDir: false fails on a missing directory', async () => {
    const nested = join(dir, 'deep', 'er')

    const outcome = await run(function* () {
      yield* JsonCodec.use()
      yield* BunIO.use()
      yield* DefaultLogger.use()

      const refused = yield* attempt(() =>
        FileTransport.use({ path: join(nested, 'a.log'), ensureDir: false }),
      )
      const stillMissing = !(yield* IO.actions.exists(nested))

      yield* FileTransport.use({ path: join(nested, 'b.log') })
      const created = yield* IO.actions.exists(nested)

      return { refused: isFailure(refused) ? refused.error : 'installed', stillMissing, created }
    })

    expect(unwrap(outcome)).toEqual({
      refused: LoggerErrors.Configuration,
      stillMissing: true,
      created: true,
    })
  })

  it('an array payload joins the message as JSON; only plain objects become data', () => {
    expect(normalizePayload(['items', [1, 2] as never])).toEqual({
      msg: 'items [1,2]',
      data: undefined,
      error: '',
    })
    expect(normalizePayload(['fields', { a: 1 }, { b: 2 }])).toEqual({
      msg: 'fields',
      data: { a: 1, b: 2 },
      error: '',
    })
  })
})
